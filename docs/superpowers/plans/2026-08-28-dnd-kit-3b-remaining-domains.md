# dnd-kit 3b: The Remaining Drag Domains — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move every drag registration still on `@atlaskit/pragmatic-drag-and-drop` over to
`@dnd-kit/dom`, following the imperative pattern 3a proved, so that after this plan the only
things left holding that dependency are the two `package.json` lines and the HTML5 half of the
test harness — which 3c removes.

**Architecture:** 3a established that `@dnd-kit/dom` exports `DragDropManager`, `Draggable` and
`Droppable` as classes, that a plain DOM element registers with `new Draggable({ element }, manager)`
and unregisters with `entity.destroy()`, and that arbitrary `data` survives the round trip. Every
task here is that same shape applied to one payload. The one new piece of infrastructure is
`src/lib/dndTarget.ts`, which says the drop-target effect once instead of the eight times it is
currently written out.

**Tech Stack:** React 19, TypeScript 6.0.x, Vitest, Storybook 10, `@dnd-kit/dom` 0.5.0 (pinned
through `@dnd-kit/react` 0.5.0).

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §6.4.

**Predecessor:** [`2026-08-27-dnd-kit-3a-foundation-and-folder-tree.md`](2026-08-27-dnd-kit-3a-foundation-and-folder-tree.md),
executed on branch `dnd-kit-3a`. Read `src/lib/dndManager.ts`, `src/lib/folderDrag.ts`,
`src/test-drag.ts` and the `## Drag and drop` section of
[`docs/reference/frontend-design.md`](../../reference/frontend-design.md) before starting. **3b
does not begin until 3a is merged into `main`** — every task below imports from
`@/lib/dndManager`.

---

## What the domains actually are

Counted in the post-3a tree on 2026-08-28 (`wc -l`, and `grep -n 'from "@atlaskit'`). **The list
this plan was briefed with — `collectionDrag.ts`, `wishDrag.ts`, `deckDrag.ts`, `categoryDrag.ts`,
`dnd.ts`, `useSidebarDrops.ts` — is real but incomplete.** Seven more files hold a registration of
their own, and one of them is a 4 328-line component. The full list:

| File | Lines | What it registers |
| --- | --- | --- |
| `src/features/decks/dnd.ts` | 563 | `composedDraggable` — the **only** `draggable()` any card in the app goes through |
| `src/features/collection/collectionDrag.ts` | 342 | `collectionDraggable`, `collectionTileDraggable`, `useCollectionDropTarget` |
| `src/features/wishlist/wishDrag.ts` | 199 | `wishDraggable`, `useWishDropTarget` |
| `src/features/decks/categoryDrag.ts` | 218 | `useCategoryDragSource`, `useCategoryReorderDrop` |
| `src/features/decks/deckDrag.ts` | 166 | `deckDraggable`, `useDeckDragging`, `useDeckDropTarget` |
| `src/components/useSidebarDrops.ts` | 187 | one `monitorForElements` |
| `src/lib/dragPreview.ts` | 82 | `setCustomNativeDragPreview` — the multi-card count chip |
| `src/features/decks/cardControl.tsx` | 991 | `useCategoryDrop` — monitor + drop target, per pile |
| `src/features/decks/QuickZones.tsx` | 563 | one monitor, and a drop target per quick zone |
| `src/features/decks/PriceStrip.tsx` | 238 | one monitor, and the remove tray's drop target |
| `src/features/decks/CategoriesDialog.tsx` | 768 | a `draggable` + drop target per row |
| `src/components/AppShell.tsx` | 825 | a drop target per sidebar entry |
| `src/features/decks/DeckEditor.tsx` | 4 328 | `autoScrollForElements` on the editor's scroller |

### The finding that decides how this plan is cut

**The six domains are not independent, and "one task per domain" does not survive contact with
the code.** `collectionDraggable`, `collectionTileDraggable`, `wishDraggable` and `cardDraggable`
all call `composedDraggable`, which is the single `draggable()` behind every card, row, tile and
wish in the app. One element, one registration, one payload record carrying up to three marks
(`dragSource`, `collectionSource` or `collectionTileSource`, `wishSource`). So the moment
`composedDraggable` becomes a dnd-kit `Draggable`, **every reader of that payload has to be a
dnd-kit `Droppable` in the same commit** — the deck's piles, the quick zones, the remove tray,
both sidebar entries, every collection folder and every wishlist folder.

**Registering both libraries on one source to bridge the gap was considered and is not viable.**
Read from `node_modules/@dnd-kit/dom/index.js` on 2026-08-28: `PointerSensor.handlePointerDown`
computes `isNativeDraggable = isHTMLElement(target) && target.draggable && target.getAttribute("draggable") === "true"`
and then binds a **capture-phase `dragstart` listener on every document** which is
`isNativeDraggable ? this.handleCancel : preventDefault`. `target` there is what was *pressed*, not
the registered element. So a press on the row itself lets the native drag win and dnd-kit stands
down — but a press on any child (a card's own name button, a tile's art, a stepper) is not a native
draggable, and dnd-kit **`preventDefault()`s the native `dragstart` in the capture phase**, killing
the pragmatic drag before its handler runs. Most presses in this app land on a child. Dual
registration would therefore break the shipped drag on exactly the gestures a test written for
either library would not be looking at.

The consequence is Task 5: the card payload migrates whole, in one commit, across nine production
files, eighteen test files and four story files. It is the largest task in this plan and it cannot
be cut smaller without shipping a broken commit. Tasks 1–4 exist to make it as small as it can
honestly be.

### Which payloads *are* independent

- **The category reorder** (`CATEGORY_MARK` under its own key) — `readCategoryDrag` refuses every
  other payload and every other reader refuses it. Source and targets are `categoryDrag.ts` and
  `CategoriesDialog.tsx` and nothing else. → **Task 2.**
- **The deck drag** (`DECK_MARK` under `dnd.ts`'s `dragSource` key, deliberately, so a deck and a
  card refuse each other) — source and targets are `deckDrag.ts` and its three call sites. → **Task 3.**
- **Everything else** is the card payload. → **Task 5.**

### The two hazards this migration introduces that pragmatic-dnd did not have

1. **Two drop targets on one element are now legal, and the rule that replaces "one per element"
   is `accept`.** pragmatic-dnd keeps one `dropTargetForElements` per element in a `WeakMap` and a
   second `set` silently replaces the first — which is why `CollectionFolderCard.tsx` and
   `WishFolderCard.tsx` put the folder target on an inner `<div ref={slot}>` and `StackView.tsx`
   puts the category-reorder target on an inner `<div ref={attachReorder}>`. dnd-kit keys its
   registry by **entity id** (`dndId()` in `lib/dndManager.ts` hands out a fresh one per
   registration), so two `Droppable`s on one element both register and both compete. What keeps
   them apart is `Droppable.accepts(source)`: `computeCollisions` in
   `node_modules/@dnd-kit/abstract/index.js` does `if (source && !entry.accepts(source)) continue`
   before it ever measures. **The nested wrappers must stay** — they are load-bearing for the
   existing tests and stories, which address them by element — but the *reason* changes, and every
   doc comment saying "pdnd allows one drop target per element" has to be corrected where it is
   touched rather than left saying something that is no longer why.
2. **Overlapping drop targets are decided by geometry, not by paint order.** pragmatic-dnd
   hit-tests with `event.target` and walks up with `Element.closest`, so the sticky quick-zone bar
   and the sticky remove tray win simply by being painted on top. dnd-kit's
   `defaultCollisionDetection` is `pointerIntersection(args) ?? shapeIntersection(args)`, and
   `pointerIntersection` returns `value = 1 / Point.distance(droppable.shape.center, pointer)` —
   so between an overlay and the pile underneath it, **the one whose centre is nearer the pointer
   wins**, which is not the one on top. `LAYER.dragTray`'s z-index means nothing here. The fix is
   `collisionPriority`, which `computeCollisions` applies as an override
   (`if (entry.collisionPriority != null) collision.priority = entry.collisionPriority`) and
   `sortCollisions` sorts by first. Task 5 gives the four quick zones and the remove tray
   `CollisionPriority.Highest`.

---

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; this plan
  touches no Rust, so CI's Rust job is not in play, but the frontend job is.
- **`src/stories.test.tsx` collects the whole story tree.** A targeted `npm run test -- <path>`
  run **never touches a story play**, and four story files drive drags by hand
  (`AppShell.stories.tsx`, `QuickZones.stories.tsx`, `CollectionFolderCard.stories.tsx`,
  `WishFolderCard.stories.tsx`). Every task below says explicitly to run
  `npm run test -- src/stories.test.tsx`, and no task is done until it is green.
- **Never assert a new drop works without re-asserting the old ones still do.** Every task carries
  a step that runs the drags it did *not* touch. This is not ceremony: the two hazards above are
  both invisible from inside the feature being changed.
- **The pure halves do not move.** `dragData`, `withDragGroup`, `readDragData`, `readDragGroup`,
  `dropWrite`, `dropWrites`, `deckCardSlot`, `collectionDragData`, `readCollectionDrag`,
  `collectionTileDragData`, `readCollectionTileDrag`, `readCollectionDrop`, `wishDragData`,
  `readWishDrag`, `deckDragData`, `readDeckDrag`, `categoryDragData`, `readCategoryDrag`,
  `movedTo`, `cardCountLabel` are all library-agnostic — a record, a field-by-field read, or
  arithmetic. **Their existing tests must keep passing untouched**, and a task that finds itself
  editing one of them has gone wrong.
- **Two dependencies get *declared* here and no new version is resolved.** 3a shipped importing
  `@dnd-kit/dom` while `package.json` names only `@dnd-kit/react`, so the module every drag in the
  app goes through is an **undeclared transitive** — one `npm update` away from resolving to a
  version nothing pinned. Task 1 declares `@dnd-kit/dom` and `@dnd-kit/abstract` (Task 5 needs
  `CollisionPriority` from it), both `0.5.0` **exactly, no caret**, which is what the lockfile
  already resolves them to. Whether `@dnd-kit/react` itself stays — nothing in `src/` imports it —
  is 3c's to settle.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned.
- Storybook: after changing anything that alters how UI looks, call `preview-stories` and include
  every returned URL in the task's report.
- **Do not run two `npm run verify`s at once** — concurrent runs fake schema failures that look
  like real ones.

---

### Task 1: The drop target, said once — `src/lib/dndTarget.ts`

**Files:**
- Create: `src/lib/dndTarget.ts`
- Create: `src/lib/dndTarget.test.ts`
- Modify: `package.json` — declare the two dnd-kit packages the code actually imports
- Modify: `src/lib/dndManager.ts` — export the register-now helper
- Modify: `src/lib/folderDrag.ts` — import it instead of keeping a private copy

**Interfaces:**
- Consumes: `dndManager`, `dndId` from `@/lib/dndManager`.
- Produces: `useDndDropTarget`, `useDndDragging`, `dndDraggable` — the three shapes Tasks 2, 3
  and 5 all need, and `registerNow` re-homed so there is one copy of the leak fix.

> **Why this is a task and not a paragraph in each of the others.** Eight places in the app write
> the same effect: a `Droppable`, an `accept` that reads the payload and asks `canDrop`, an
> `armed` flag off `dragstart`, an `over` flag off `dragover`, a handler on `dragend` that asks
> `canDrop` again before it writes, and a teardown. Written eight times against a new library it
> is eight chances to get `operation.target !== droppable` or the cancel path wrong. Written once
> it is one thing to test hard, and Task 5 — the task that cannot be split — becomes a rewiring
> rather than eight re-derivations.

> **`useFolderDropTarget` deliberately does not move onto it.** That hook returns an *edge*, not a
> boolean, and it listens to `dragmove` as well as `dragover` because the whole gesture is that
> one folder means three different things at three heights. Folding it in would mean widening this
> primitive for its one caller and re-opening a hook that 3a proved in the shipped window. It stays
> as it is; only its private `registerNow` moves.

- [ ] **Step 1: Record the baseline**

```bash
npm run test -- src/lib/folderDrag.test.ts src/lib/dndManager.test.ts src/test-drag.test.ts 2>&1 | tail -8
```

Write down `Test Files` and `Tests`. These are what "3a is unchanged" means for the rest of this
plan, and every later task compares against them.

- [ ] **Step 2: Declare the two packages the code imports**

```bash
npm install --save-exact @dnd-kit/dom@0.5.0 @dnd-kit/abstract@0.5.0
grep -n '"@dnd-kit/' package.json
```
Expected: `"@dnd-kit/abstract": "0.5.0"`, `"@dnd-kit/dom": "0.5.0"`, `"@dnd-kit/react": "0.5.0"` —
**no carets**. If npm wrote one, fix it by hand.

This resolves no new version: `package-lock.json` already pins all three at 0.5.0, because
`@dnd-kit/react` depends on `@dnd-kit/dom` which depends on `@dnd-kit/abstract`. What it fixes is
that 3a shipped `src/lib/dndManager.ts` importing `@dnd-kit/dom` while `package.json` named only
`@dnd-kit/react` — an undeclared transitive under every drag in the app, one `npm update` from
resolving to something nothing pinned. `@dnd-kit/abstract` joins it because Task 5 imports
`CollisionPriority` from there: `@dnd-kit/dom`'s barrel re-exports exactly two symbols from it
(`Customizable`, `resolveCustomizable`) and that enum is not one of them.

Confirm the install changed nothing in the tree:

```bash
git diff --stat package-lock.json
```
Expected: no change, or only the three `""` → `"0.5.0"` root-dependency lines. **A version bump
here means npm resolved something new and the pin is not doing what it says** — stop and report.

- [ ] **Step 3: Move `registerNow` into `dndManager.ts` and export it**

`src/lib/folderDrag.ts` has it as a private function with a long doc comment recording a leak only
the running window could find. Move the function **and its whole comment** to the foot of
`src/lib/dndManager.ts`, beside `dndId`, and export it:

```ts
/**
 * Register an entity **now**, rather than on the microtask dnd-kit would have used.
 *
 * (Move the existing comment from `folderDrag.ts` here verbatim — it records that `Entity`'s
 * constructor ends with `if (manager && register) queueMicrotask(this.register)` while
 * `destroy()` unregisters synchronously, so an entity built and destroyed in one tick leaks for
 * the life of the page; that `React.StrictMode` does exactly that on every mount in development;
 * and that it was measured in the shipped dev window on 2026-08-27 as eleven droppables for four
 * folders. Do not paraphrase it. It moves here because three more modules are about to need it,
 * and a second copy is a second place for the leak to come back.)
 *
 * `register: false` at the call site is the other half — without it the constructor still queues
 * its own registration and this merely adds a second.
 */
export function registerNow(entity: Draggable | Droppable): void {
  entity.register();
}
```

`dndManager.ts`'s import line becomes:

```ts
import {
  Accessibility,
  DragDropManager,
  Draggable,
  Droppable,
  KeyboardSensor,
  PointerSensor,
} from "@dnd-kit/dom";
```

Then in `folderDrag.ts`, delete the private copy and take it from the manager module:

```ts
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
```

- [ ] **Step 4: Write the failing tests for the new module**

Create `src/lib/dndTarget.test.ts`. It builds its own source and its own target out of raw
dnd-kit, so it depends on nothing this plan has not migrated yet — the same idiom
`folderDrag.test.ts` already uses, including its `boxed` helper and its `undo` stack.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { Draggable } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { useDndDragging, useDndDropTarget } from "@/lib/dndTarget";
import { startPointerDrag } from "@/test-drag";

/** A payload of this file's own, under a key nothing else in the app writes — so a reader that
 *  stopped checking its mark cannot pass here on somebody else's record. */
const MARK_KEY = "dndTargetTestSource";
const MARK = "mtg-grimoire/dnd-target-test";
interface Thing {
  id: number;
}
const data = (id: number): Record<string, unknown> => ({ [MARK_KEY]: MARK, id });
const read = (record: Record<string, unknown>): Thing | null =>
  record[MARK_KEY] === MARK && typeof record.id === "number" ? { id: record.id } : null;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** jsdom measures every box as zero and dnd-kit hit-tests by coordinate, so a target a drag is
 *  meant to arrive at has to be given somewhere to be. `folderDrag.test.ts`'s helper. */
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

function mountSource(id: number): HTMLElement {
  const element = boxed(document.createElement("div"), 0);
  element.textContent = "a thing";
  document.body.append(element);
  const draggable = new Draggable(
    { id: dndId("test-source"), element, data: data(id), register: false },
    dndManager,
  );
  registerNow(draggable);
  undo.push(() => {
    draggable.destroy();
    element.remove();
  });
  return element;
}

interface Props {
  canDrop: (thing: Thing) => boolean;
  onDrop: (thing: Thing) => void;
}

function mountTarget({ top = 200, ...props }: Partial<Props> & { top?: number } = {}) {
  const element = boxed(document.createElement("div"), top);
  document.body.append(element);
  undo.push(() => element.remove());
  const initialProps: Props = { canDrop: () => true, onDrop: () => {}, ...props };
  const ref = { current: element as HTMLElement | null };
  const view = renderHook(
    (current: Props) => useDndDropTarget({ ref, read, ...current }),
    { initialProps },
  );
  let current = initialProps;
  return {
    element,
    get state() {
      return view.result.current;
    },
    rerender(next: Partial<Props>) {
      current = { ...current, ...next };
      act(() => view.rerender(current));
    },
  };
}

describe("useDndDropTarget", () => {
  it("arms every target that would take the payload, and no others", async () => {
    const takes = mountTarget();
    const refuses = mountTarget({ top: 400, canDrop: () => false });
    const held = await startPointerDrag(mountSource(7));

    expect(takes.state.armed).toBe(true);
    expect(refuses.state.armed).toBe(false);

    await held.cancel();
    expect(takes.state.armed).toBe(false);
  });

  it("is blind to a payload it cannot read", async () => {
    const target = mountTarget();
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const stranger = new Draggable(
      { id: dndId("stranger"), element, data: { somethingElse: true }, register: false },
      dndManager,
    );
    registerNow(stranger);
    undo.push(() => {
      stranger.destroy();
      element.remove();
    });

    const held = await startPointerDrag(element);
    expect(target.state.armed).toBe(false);
    await held.over(target.element);
    expect(target.state.over).toBe(false);
    await held.cancel();
  });

  it("says `over` for the one target under the pointer, and takes it back on the way out", async () => {
    const here = mountTarget();
    const there = mountTarget({ top: 400 });
    const held = await startPointerDrag(mountSource(7));

    await held.over(here.element);
    expect(here.state.over).toBe(true);
    expect(there.state.over).toBe(false);

    await held.over(there.element);
    expect(here.state.over).toBe(false);
    expect(there.state.over).toBe(true);

    await held.leave();
    expect(there.state.over).toBe(false);
    await held.cancel();
  });

  it("runs the handler on the target the pointer was over, with the payload", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    await held.drop();

    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledWith({ id: 9 });
  });

  /** Escape ends the drag the same way a drop does, so both flags have to stand down without this
   *  hook hearing a keypress — and nothing may be written. */
  it("writes nothing and stands down when the drag is cancelled", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    await held.cancel();

    expect(onDrop).not.toHaveBeenCalled();
    expect(target.state.armed).toBe(false);
    expect(target.state.over).toBe(false);
  });

  /**
   * **`canDrop` is asked again on the drop, and the second answer is the one that writes.** The
   * two questions can be a second apart — a refetch lands, a folder is deleted — and only the
   * second one is in front of a write.
   */
  it("refuses on the drop a payload it accepted on the way in", async () => {
    const onDrop = vi.fn();
    const target = mountTarget({ onDrop });
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    target.rerender({ canDrop: () => false });
    await held.drop();

    expect(onDrop).not.toHaveBeenCalled();
  });

  /** The handlers are read through a ref rather than through the effect's deps, so a page that
   *  re-renders mid-drag does not unregister the target the pointer is over. */
  it("keeps one registration across a re-render with new handlers", async () => {
    const onDrop = vi.fn();
    const target = mountTarget();
    const held = await startPointerDrag(mountSource(9));
    await held.over(target.element);
    target.rerender({ onDrop });
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith({ id: 9 });
  });
});

describe("useDndDragging", () => {
  it("answers the payload while it is in the air and null before and after", async () => {
    const view = renderHook(() => useDndDragging(read));
    expect(view.result.current).toBeNull();

    const held = await startPointerDrag(mountSource(3));
    expect(view.result.current).toEqual({ id: 3 });

    await held.cancel();
    expect(view.result.current).toBeNull();
  });

  it("stays null for a drag it cannot read", async () => {
    const view = renderHook(() => useDndDragging(read));
    const element = boxed(document.createElement("div"), 0);
    document.body.append(element);
    const stranger = new Draggable(
      { id: dndId("stranger"), element, data: { somethingElse: true }, register: false },
      dndManager,
    );
    registerNow(stranger);
    undo.push(() => {
      stranger.destroy();
      element.remove();
    });

    const held = await startPointerDrag(element);
    expect(view.result.current).toBeNull();
    await held.cancel();
  });
});
```

- [ ] **Step 5: Run, and confirm the red is the red you meant**

Run: `npm run test -- src/lib/dndTarget.test.ts 2>&1 | tail -20`

Expected: the **file fails to load** — `Failed to resolve import "@/lib/dndTarget"`. That is a
real red and not a vacuous one, but it proves only that the module is missing. The assertions
themselves are proved by Step 8's mutation.

- [ ] **Step 6: Implement `src/lib/dndTarget.ts`**

```ts
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
        // `register: false` and a registration of our own — see `registerNow`.
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
 * target's own policy would be `useDndDropTarget` with the target left out.
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
 * narrower *listener* rather than a check run after the fact. Read the note at Task 2 before
 * using it: a handle also switches the default activation constraints off, which is not what this
 * app wants, so a `handle` caller passes its own.
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
```

- [ ] **Step 7: Run the new tests**

Run: `npm run test -- src/lib/dndTarget.test.ts 2>&1 | tail -12`
Expected: 9 passed, 0 failed. If any fail, fix the module rather than the test — the assertions
above are what the eight call sites are going to depend on.

- [ ] **Step 8: Mutate, and confirm each mutation goes red**

Run each of these, one at a time, reverting between:

1. In `useDndDropTarget`'s `dragend` listener, delete the `if (canceled …) return;` line's
   `canceled ||` clause. **"writes nothing and stands down when the drag is cancelled" must fail.**
2. In the `dragend` listener, replace `const drop = taken(operation.source)` with
   `const drop = latest.current.read(operation.source?.data ?? {})` — i.e. drop the second
   `canDrop`. **"refuses on the drop a payload it accepted on the way in" must fail.**
3. In the `dragover` listener, drop the `operation.target === droppable &&`. **"says `over` for
   the one target under the pointer" must fail** on `there.state.over`.
4. Add `canDrop` and `onDrop` to the second effect's dependency array. **"keeps one registration
   across a re-render with new handlers" must fail.**
5. In `accept`, return `true` unconditionally. **"is blind to a payload it cannot read" must fail.**

**If any of the five survives, stop and report.** A drop-target primitive eight call sites are
about to be rewritten onto is not something to take on trust, and a mutation that survives means
the test asserting it is measuring something other than what it says.

- [ ] **Step 9: Re-assert 3a, which this task touched**

`registerNow` moved out of `folderDrag.ts`. That is a change to the module 3a shipped, so:

```bash
npm run test -- src/lib/folderDrag.test.ts src/lib/dndManager.test.ts src/test-drag.test.ts 2>&1 | tail -8
```
Expected: **every count identical to Step 1.** `folderDrag.test.ts` has a test that mounts under
`StrictMode` and counts registrations — that is the one this move could break, and it is the one
that proves the comment moved with the code rather than away from it.

- [ ] **Step 10: Run the story plays**

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```
Expected: unchanged and green. Nothing in this task should reach a story, and that is the point of
running it: `src/stories.test.tsx` collects the whole tree, so this is the only run that would
catch it if something did.

- [ ] **Step 11: Commit**

```bash
npm run verify > /tmp/verify-3b-1.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3b-1.log
git add package.json package-lock.json src/lib/dndTarget.ts src/lib/dndTarget.test.ts src/lib/dndManager.ts src/lib/folderDrag.ts
git commit -m "feat(dnd): the drop-target effect, written once

Eight places in this app write the same effect — a Droppable, an accept that reads the payload
and asks canDrop, an armed flag off dragstart, an over flag off dragover, a handler on dragend
that asks canDrop again before it writes. Written eight times against a new library it is eight
chances to get the cancel path or the target comparison wrong.

useDndDragging is the window-wide half, which four surfaces ask for and which has to answer with
the payload rather than a boolean: the sidebar draws a ring only for a card it could take, and a
folder the deck is already in must not light up.

registerNow moves here from folderDrag.ts with its comment: three more modules are about to need
the leak fix, and a second copy is a second place for it to come back. The folder drag's own
counts are asserted unchanged in the same run.

useFolderDropTarget deliberately does not move onto the primitive. It answers with an edge rather
than a boolean and listens to dragmove for it, so folding it in would widen this for its one
caller and re-open a hook already proved in the shipped window.

@dnd-kit/dom and @dnd-kit/abstract are declared exactly, at the version the lockfile already
resolves. 3a shipped importing the first while package.json named only @dnd-kit/react, which put
the module every drag in the app goes through one npm update away from a version nothing pinned."
```

---

### Task 2: The category reorder — `categoryDrag.ts` and `CategoriesDialog.tsx`

**Files:**
- Modify: `src/features/decks/categoryDrag.ts` — `useCategoryDragSource` and `useCategoryReorderDrop`
- Modify: `src/features/decks/CategoriesDialog.tsx` — the per-row `draggable` + `dropTargetForElements` in `CategoryRow`'s effect (~line 380–425)
- Test: `src/features/decks/categoryDrag.test.ts` (65 lines, 7 tests), `src/features/decks/CategoriesDialog.test.tsx` (877 lines, 24 tests, 3 drag calls at ~601/606/624), `src/features/decks/views/views.test.tsx` (3 567 lines, 107 tests — **only the five reorder calls at ~3078/3082/3112/3120/3128**; the four card drops in the same file at ~733/1722/2272/3158 belong to Task 5 and must be left alone)

**Interfaces:**
- Consumes: `useDndDropTarget`, `useDndDragging`, `dndDraggable` (Task 1).
- Produces: `useCategoryDragSource` and `useCategoryReorderDrop` with **the signatures they have
  today** — `{ attachSource, attachHandle }` and `{ attach, over, eligible }`. `StackView.tsx` and
  `CategoriesDialog.tsx` are not rewired.

> **This payload goes first because it is the only one that is genuinely alone.** `CATEGORY_MARK`
> is `"mtg-grimoire/category-order"` under a key of its own — not `dnd.ts`'s `dragSource` — so
> `readCategoryDrag` refuses every other drag in the window and every other reader refuses this
> one. Two surfaces offer it and nothing else touches it. It is the second proof of 3a's pattern
> at a size where a mistake is still cheap.

> **The grip is where the interesting decision is.** Both surfaces hand-roll the same thing today:
> a capture-phase `mousedown` on the row remembering whether the press landed inside the grip, and
> `canDrag: () => fromHandle`. dnd-kit has that natively — `PointerSensor.bind` listens on
> `source.handle ?? source.element`, so a handle is a narrower listener rather than a check run
> afterwards, and a press outside it never reaches the sensor at all. **But it comes with a
> change nobody asked for:** `PointerSensor.defaults.activationConstraints` returns `undefined`
> for a mouse press where `source.handle === target || source.handle.contains(target)`, which
> means *no distance and no delay* — the drag begins on `pointerdown`, and a plain click on the
> grip becomes a zero-pixel drag. Today it takes 5px of travel. So the `handle` is used **and**
> the constraint is put back explicitly, per source.

- [ ] **Step 1: Record the baseline**

```bash
npm run test -- src/features/decks/categoryDrag.test.ts src/features/decks/CategoriesDialog.test.tsx src/features/decks/views/views.test.tsx 2>&1 | tail -8
```
Write down `Test Files` and `Tests`. Note that `views.test.tsx` currently makes **nine** HTML5
drag calls; five are reorders and four are card drops. Only the first five change here, so the
file's test count must not move.

- [ ] **Step 2: Write the failing test for the pointer-driven reorder**

Append to `src/features/decks/categoryDrag.test.ts`. The file today is pure arithmetic
(`movedTo`, `readCategoryDrag`) and mounts nothing — this is its first wiring test, so it brings
the harness with it.

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { startPointerDrag } from "@/test-drag";
import { categoryDragData, useCategoryDragSource, useCategoryReorderDrop } from "./categoryDrag";

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

/** dnd-kit hit-tests by coordinate and jsdom measures every box as zero. */
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

/** A heading with a grip inside it — the shape both surfaces draw, and the only shape where the
 *  press guard means anything. */
function mountSource(id: number, top = 0) {
  const heading = boxed(document.createElement("div"), top);
  const grip = document.createElement("button");
  grip.textContent = "Move";
  const name = document.createElement("button");
  name.textContent = "Ramp";
  heading.append(grip, name);
  document.body.append(heading);
  const view = renderHook(() => useCategoryDragSource(id));
  act(() => {
    view.result.current.attachHandle(grip);
    view.result.current.attachSource(heading);
  });
  undo.push(() => heading.remove());
  return { heading, grip, name };
}

function mountTarget(id: number, onMove: (from: number, to: number) => void, top = 200) {
  const element = boxed(document.createElement("div"), top);
  document.body.append(element);
  const view = renderHook(() => useCategoryReorderDrop(id, onMove));
  act(() => {
    view.result.current.attach(element);
  });
  undo.push(() => element.remove());
  return {
    element,
    get state() {
      return view.result.current;
    },
  };
}

describe("the category reorder, as a pointer gesture", () => {
  it("moves a pile onto the pile it was let go over", async () => {
    const onMove = vi.fn();
    const target = mountTarget(2, onMove);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    expect(held.started).toBe(true);
    await held.over(target.element);
    await held.drop();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith(1, 2);
  });

  /**
   * **The press guard, which is the whole reason the heading is the source and the grip is only
   * where a press may start.** A heading carries the pile's name — a button, because it is the
   * keyboard's way in — and a press on it must not move the pile.
   */
  it("does not start from a press on the heading's own name", async () => {
    const target = mountTarget(2, () => {});
    const { heading, name } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: name });
    expect(held.started).toBe(false);
    await held.cancel();
    expect(target.state.eligible).toBe(false);
  });

  /**
   * **A click on the grip is a click, not a zero-pixel reorder.** dnd-kit switches its activation
   * constraints off for a press inside a declared handle, so this is the behaviour the source has
   * to put back — 5px of travel, which is what the gesture has always cost.
   */
  it("needs travel before a press on the grip becomes a drag", async () => {
    mountTarget(2, () => {});
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip, move: false });
    expect(held.started).toBe(false);
    await held.moveTo(100, 3);
    expect(held.started).toBe(false);
    await held.moveTo(100, 20);
    expect(held.started).toBe(true);
    await held.cancel();
  });

  it("arms every other pile and never the one being dragged", async () => {
    const other = mountTarget(2, () => {});
    const itself = mountTarget(1, () => {}, 400);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    expect(other.state.eligible).toBe(true);
    expect(itself.state.eligible).toBe(false);

    await held.cancel();
    expect(other.state.eligible).toBe(false);
  });

  it("writes nothing when the reorder is cancelled", async () => {
    const onMove = vi.fn();
    const target = mountTarget(2, onMove);
    const { heading, grip } = mountSource(1);

    const held = await startPointerDrag(heading, { pressOn: grip });
    await held.over(target.element);
    await held.cancel();

    expect(onMove).not.toHaveBeenCalled();
    expect(target.state.over).toBe(false);
  });

  /** The fence between the two drags in this feature, from the source side: a category payload
   *  carries this module's mark and `dnd.ts`'s reader must go on finding nothing in it. */
  it("carries a payload no card reader can read", () => {
    expect(categoryDragData(4)).toEqual({ "mtg-grimoire/category-order": true, categoryId: 4 });
  });
});
```

> **`startPointerDrag` needs one new option for the third test.** It currently presses and then
> makes two moves of 8px each, unconditionally, because every existing caller wants a drag that
> has started. A test about the *threshold* has to press without moving. Add `move?: boolean`
> (default `true`) to its options in `src/test-drag.ts`, guarding only the two `await move(...)`
> calls in the body — nothing else changes, and every existing caller keeps today's behaviour by
> omission. Say so in the helper's doc comment.

- [ ] **Step 3: Run to verify it fails, and check *how* it fails**

Run: `npm run test -- src/features/decks/categoryDrag.test.ts 2>&1 | tail -25`

Expected: the five wiring tests fail and `carries a payload no card reader can read` passes.
**Read the failure text.** If it says `attachHandle is not a function` the harness is wrong, not
the subject. The failure you want on the first four is `expect(held.started).toBe(true)` receiving
`false` — pragmatic-dnd is registered and nothing is listening for a pointer.

- [ ] **Step 4: Migrate `categoryDrag.ts`**

Replace the imports and the two hooks' bodies. Keep every doc comment on both — they carry the
2026-08-17 live measurement about the preview, the `elementFromPoint` trap that made the first
attempt read as Chromium refusing a form control, and the `attach`-not-`ref` naming rule. Correct
only the sentences that name pragmatic-dnd specifically.

```ts
import { useCallback, useEffect, useRef, useState } from "react";
import { PointerActivationConstraints, PointerSensor } from "@dnd-kit/dom";
import { useDndDragging, useDndDropTarget, dndDraggable } from "@/lib/dndTarget";
```

`useCategoryReorderDrop` becomes the primitive plus this module's own two questions:

```ts
export function useCategoryReorderDrop(
  categoryId: number | null,
  onMove?: (categoryId: number, targetId: number) => void,
) {
  const enabled = categoryId !== null && onMove !== undefined;
  const ref = useRef<HTMLElement | null>(null);

  // The same question twice — "a pile is in the air and it is not this one" — asked once for the
  // ring and once for the write. A pile dragged over itself lights nothing.
  const canDrop = useCallback(
    (dragged: number) => categoryId !== null && dragged !== categoryId,
    [categoryId],
  );
  const onDrop = useCallback(
    (dragged: number) => {
      if (categoryId !== null) onMove?.(dragged, categoryId);
    },
    [categoryId, onMove],
  );
  const { armed, over } = useDndDropTarget({ ref, read: readCategoryDrag, canDrop, onDrop });

  // `attach` rather than `ref` — React's ref lint reads a hook result called `ref` as a ref
  // object and flags every read beside it as a ref access during render. `useCategoryDrop`
  // carries the same name for the same reason.
  const attach = useCallback(
    (element: HTMLElement | null) => {
      ref.current = element;
      return () => {
        ref.current = null;
      };
    },
    [],
  );

  return { attach, over: over && enabled, eligible: armed && enabled };
}
```

> **`useDndDropTarget` takes a ref and this hook hands back a callback, so the two are bridged
> here rather than in the primitive.** The bridge has a cost that has to be stated: the primitive's
> effect reads `ref.current` once, on mount, and a callback ref that fires *after* that effect
> would leave the target unregistered. React calls a ref callback during the commit, before
> effects run, so the order is right — but a `null`-then-element sequence across two renders is
> not, and that is what the `attach` above returning a cleanup avoids. **Assert it**: the fourth
> test above mounts the hook and attaches in the same `act`, which is the order React really
> produces. If it fails, the primitive needs `ref.current` re-read rather than this hook needing a
> workaround.

`useCategoryDragSource` keeps its two-callback shape and loses its hand-rolled guard:

```ts
export function useCategoryDragSource(id: number | null) {
  const handleRef = useRef<HTMLElement | null>(null);

  const attachHandle = useCallback((element: HTMLElement | null) => {
    handleRef.current = element;
    return () => {
      handleRef.current = null;
    };
  }, []);

  const attachSource = useCallback(
    (element: HTMLElement | null) => {
      const handle = handleRef.current;
      if (!element || id === null || !handle) return;
      return dndDraggable({
        element,
        handle,
        data: () => categoryDragData(id),
        // **Put the threshold back.** dnd-kit's default `activationConstraints` returns
        // `undefined` for a mouse press inside a declared handle — no distance, no delay — so a
        // plain click on the grip would become a zero-pixel reorder. 5px is what the gesture has
        // cost since it shipped, and it is dnd-kit's own default everywhere a handle is *not*
        // declared, so this is the library's number rather than a new one.
        sensors: [
          PointerSensor.configure({
            activationConstraints: [new PointerActivationConstraints.Distance({ value: 5 })],
          }),
        ],
      });
    },
    [id],
  );

  return { attachSource, attachHandle };
}
```

> **`attachSource` now depends on the handle having been attached first**, which is a real
> ordering requirement and not one React guarantees between two sibling ref callbacks. Both
> surfaces put the grip *inside* the heading, so the child's ref runs first — but say it in the
> comment, and let `attachSource` return early rather than register a handle-less draggable that
> would drag from anywhere. That early return is what the third test would catch if the order ever
> inverted: a handle-less source has no activation constraints of its own and starts on
> `pointerdown` from the name button.

- [ ] **Step 5: Migrate `CategoriesDialog.tsx`'s row**

`CategoryRow`'s effect at ~line 380 currently registers a `draggable` and a
`dropTargetForElements` on the same `row` element with a hand-rolled `fromHandle` guard. Replace
the whole effect with the two hooks this feature already owns — the dialog's row and the stack's
pile are the same gesture, and the dialog has been carrying its own copy since before
`categoryDrag.ts` existed.

The row's `onMove(dragged, index)` takes an **index**, while `useCategoryReorderDrop` hands back
the target's **id**. The dialog holds the whole list, so resolve it at the call site:

```ts
const { attach, over } = useCategoryReorderDrop(category.id, (dragged, targetId) => {
  const to = categories.findIndex((one) => one.id === targetId);
  if (to >= 0) onMove(dragged, to);
});
const { attachSource, attachHandle } = useCategoryDragSource(category.id);
```

and hand `attachHandle` to the grip button, `attachSource` and `attach` to the row. **Two
registrations on one element are now legal** — a `Draggable` and a `Droppable` are different
registries — so unlike `StackView.tsx` the dialog needs no second box. Replace the comment that
says the library's `dragHandle` "resolves the pointer through `elementFromPoint`, which jsdom does
not answer" — dnd-kit's `handle` is an `addEventListener` target, not a hit test, so that
objection is gone and the reason it is gone is worth a sentence.

- [ ] **Step 6: Run the three suites**

```bash
npm run test -- src/features/decks/categoryDrag.test.ts src/features/decks/CategoriesDialog.test.tsx src/features/decks/views/views.test.tsx 2>&1 | tail -12
```

The three reorder tests in `CategoriesDialog.test.tsx` and the five in `views.test.tsx` are
driving HTML5 events at a gesture that no longer listens for them, so they will fail. Rewrite
exactly those eight to use `startPointerDrag`, giving each row and pile a `getBoundingClientRect`
the way `folderDrag.test.ts`'s `boxed` does. **The four card drops in `views.test.tsx` are not
touched and must still pass** — if one of them fails here, something in this task reached the card
payload and that is a defect, not a rewrite.

Expected at the end: `Tests` back to Step 1's number.

- [ ] **Step 7: Mutate the subject**

1. Delete the `sensors:` block from `useCategoryDragSource`. **"needs travel before a press on the
   grip becomes a drag" must fail** — `held.started` will be `true` after the press.
2. Change `dndDraggable`'s call to drop `handle`. **"does not start from a press on the heading's
   own name" must fail.**
3. In `useCategoryReorderDrop`'s `canDrop`, return `true` unconditionally. **"arms every other
   pile and never the one being dragged" must fail** on `itself.state.eligible`.

Revert each. **If any survives, stop and report** — a reorder that can be started by a click on a
pile's name is the shipped bug the guard exists for, and a test that does not see it is worse than
no test.

- [ ] **Step 8: Re-assert the grip's *keyboard* reorder, which this task puts a sensor on top of**

**This step exists because of a collision only this task can create, and it is not about the
mouse.** The grip already carries the whole keyboard reorder: `CategoryGrip` in `StackView.tsx`
handles `ArrowLeft`/`ArrowRight` and `CategoriesDialog`'s handle button handles
`ArrowUp`/`ArrowDown`, each writing a real move and each labelled `Move <name>, <n> of <total>` so
the reader can hear where it landed. `lib/dndManager.ts` has `KeyboardSensor` in its sensor list,
and `KeyboardSensor.bind` adds a `keydown` listener to **`source.handle ?? source.element`** —
which, from this task onward, is that exact button. Its `keyboardCodes` are
`start: ["Space", "Enter"]`, `cancel: ["Escape"]`, `end: ["Space", "Enter", "Tab"]` and
`up/down/left/right` on the four arrows.

So a press of Space or Enter on the grip now starts a dnd-kit keyboard drag — `handleStart` calls
`preventDefault()` — and while it is up, the sensor's own document-level `keydown` reads the arrows
as 10px nudges **at the same time as** the grip's React handler writes a reorder. Two things
answering one press.

```bash
npm run test -- src/features/decks/views/views.test.tsx src/features/decks/CategoriesDialog.test.tsx 2>&1 | tail -8
```
Then write the two tests that pin it, if they are not already there: **ArrowRight on a focused
grip moves the pile one place and nothing else happens**, and **Space on a focused grip does not
leave `dndManager.dragOperation.status` non-idle**. Use `cdp.mjs key`-shaped realism in jsdom by
pressing with `user.keyboard` on a genuinely focused element — a synthetic `dispatchEvent`
collapses the capture ladder into registration order and would report a false pass.

**If Space does start a drag, do not fix it here.** Record it, leave the tests asserting what
actually happens, and hand it to 3c — that plan's whole subject is which sensors this app should
have and what a keyboard drag should mean, and a fix taken here would be that decision made by
whoever happened to be holding this task.

- [ ] **Step 9: Re-assert every drag this task did not touch**

```bash
npm run test -- src/lib/folderDrag.test.ts src/features/decks/DeckEditor.test.tsx src/features/decks/QuickZones.test.tsx src/features/decks/DecksPage.test.tsx src/features/collection/CollectionPage.test.tsx 2>&1 | tail -8
```
Expected: unchanged and green. `views.test.tsx`'s card drops and `DeckEditor.test.tsx`'s fourteen
HTML5 drags are the ones at risk: a pile now carries a `Droppable` and a `Draggable` it did not
have, and `StackView.tsx`'s inner `<div ref={attachReorder}>` sits inside the `<section>` that is
the card target. Their `accept`s are disjoint — `readCategoryDrag` refuses a card and
`readDragGroup` refuses a category — but that is the claim, and this run is the evidence.

- [ ] **Step 10: Run the story plays and preview**

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```
Expected: green. `StackView.stories.tsx` and `CategoriesDialog`'s stories draw the grip and the
ring. Then call `preview-stories` for the deck views and the dialog, and put every URL in the
report.

- [ ] **Step 11: Commit**

```bash
npm run verify > /tmp/verify-3b-2.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3b-2.log
git add src/features/decks/categoryDrag.ts src/features/decks/categoryDrag.test.ts src/features/decks/CategoriesDialog.tsx src/features/decks/CategoriesDialog.test.tsx src/features/decks/views/views.test.tsx src/test-drag.ts
git commit -m "refactor(decks): moving a pile is a pointer gesture

The category reorder goes first because it is the one payload that is genuinely alone: its mark
sits under a key of its own, so no card reader can see it and it can see no card.

The grip stops being a hand-rolled capture-phase mousedown remembered for canDrag and becomes
dnd-kit's own handle, which binds the pointer listener to the grip rather than checking after the
fact. That comes with a change nobody asked for — a press inside a declared handle has no
activation constraints at all, so a click would have become a zero-pixel reorder — and the 5px
distance is put back explicitly. The test for it presses without moving, which is why the pointer
harness grew a `move: false`.

CategoriesDialog stops carrying its own copy of the gesture; the dialog's row and the desk's pile
are the same write and now the same two hooks. Its 'the library's dragHandle uses elementFromPoint
and jsdom cannot answer it' objection is gone with the library it was about.

The deck editor's card drops, the folder tree and the collection are asserted unchanged in the
same run: a pile now carries a Droppable and a Draggable it did not have, inside the section that
is the card target, and disjoint accepts is a claim that needs evidence.

The grip is also the first element in this app to be both a declared dnd-kit handle and a control
with a keyboard behaviour of its own — its arrow keys are the whole keyboard reorder. What
KeyboardSensor now does to that press is pinned by a test here and decided in 3c, whose subject
it is."
```

---

### Task 3: The deck drag — `deckDrag.ts`

**Files:**
- Modify: `src/features/decks/deckDrag.ts` — `deckDraggable`, `useDeckDragging`, `useDeckDropTarget`
- Test: `src/features/decks/DecksPage.test.tsx` (2 414 lines, 95 tests, one `startDrag` at ~1814 with a comment naming it as pragmatic), `src/features/decks/FolderTree.test.tsx` (161 lines, 14 tests), `src/components/AppShell.test.tsx` — **only if** the sidebar's deck-folder rows appear in it; the three drags there are card drags and belong to Task 5
- Create: `src/features/decks/deckDrag.test.ts` — the module has none today

**Interfaces:**
- Consumes: Task 1's three exports.
- Produces: `deckDraggable`, `useDeckDragging`, `useDeckDropTarget` with **today's signatures** —
  `useDeckDropTarget` returns a bare `boolean`, not `{ armed, over }`, and that does not change:
  `FolderTree.tsx` computes its own `eligible` from `useDeckDragging`'s payload because a folder
  the deck is already in must not light up, and that arrangement is deliberate.

> **The deck payload shares `dnd.ts`'s key on purpose, and this task must not undo it.**
> `deckDragData` writes `DECK_MARK` under `MARK_KEY = "dragSource"` — the same key `dragData`
> uses — so `readDragData` refuses a deck and `readDeckDrag` refuses a card, in both directions,
> rather than each ignoring the other. A deck dragged over a category column or the sidebar's
> Decks entry lights nothing and writes nothing, and that is the mechanism. It survives the
> library change untouched, and there is a test below that says so.

- [ ] **Step 1: Record the baseline**

```bash
npm run test -- src/features/decks/DecksPage.test.tsx src/features/decks/FolderTree.test.tsx src/components/AppShell.test.tsx 2>&1 | tail -8
```

- [ ] **Step 2: Write `src/features/decks/deckDrag.test.ts`**

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { dragData } from "@/features/decks/dnd";
import { startPointerDrag } from "@/test-drag";
import {
  deckDragData,
  deckDraggable,
  readDeckDrag,
  useDeckDragging,
  useDeckDropTarget,
  type DeckDrag,
} from "./deckDrag";

const DECK: DeckDrag = { deckId: 12, name: "Burn" };
const CARD = { kind: "card", cardId: "c1", name: "Lightning Bolt", typeLine: "Instant" } as const;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

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

function mountTile(payload: () => DeckDrag) {
  const element = boxed(document.createElement("div"), 0);
  const remove = document.createElement("button");
  remove.textContent = "Delete";
  remove.setAttribute("data-no-drag", "");
  element.append(remove);
  document.body.append(element);
  const stop = deckDraggable({ element, payload });
  undo.push(() => {
    stop();
    element.remove();
  });
  return { element, remove };
}

function mountDrawer(canDrop: (drag: DeckDrag) => boolean, onDrop: (drag: DeckDrag) => void) {
  const element = boxed(document.createElement("div"), 200);
  document.body.append(element);
  undo.push(() => element.remove());
  const ref = { current: element as HTMLElement | null };
  const view = renderHook(() => useDeckDropTarget({ ref, canDrop, onDrop }));
  return {
    element,
    get over() {
      return view.result.current;
    },
  };
}

describe("the deck drag", () => {
  /** The two fences, in both directions — the reason this module shares `dnd.ts`'s key rather
   *  than taking one of its own. */
  it("is refused by the card reader, and refuses a card", async () => {
    const { readDragData } = await import("@/features/decks/dnd");
    expect(readDragData(deckDragData(DECK))).toBeNull();
    expect(readDeckDrag(dragData(CARD))).toBeNull();
  });

  it("files a deck into the drawer it was let go over", async () => {
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    expect(drawer.over).toBe(true);
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith(DECK);
  });

  /** The press guard, which is `NOT_A_DRAG`'s and is now the sensor's: a tile carries a Delete
   *  button, and a press on it plus five pixels of travel used to be a drag of the whole tile. */
  it("does not start from a press on the tile's own control", async () => {
    const { element, remove } = mountTile(() => DECK);
    const held = await startPointerDrag(element, { pressOn: remove });
    expect(held.started).toBe(false);
    await held.cancel();
  });

  /** Read at the press, so a tile renamed since it mounted carries what it is now. */
  it("carries the deck as it is at the press", async () => {
    let deck: DeckDrag = { ...DECK };
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    const { element } = mountTile(() => deck);

    deck = { deckId: 12, name: "Burn, renamed" };
    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    await held.drop();

    expect(onDrop).toHaveBeenCalledWith({ deckId: 12, name: "Burn, renamed" });
  });

  it("refuses on the drop a deck the drawer accepted on the way in", async () => {
    const onDrop = vi.fn();
    let takes = true;
    const drawer = mountDrawer(() => takes, onDrop);
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    takes = false;
    await held.drop();

    expect(onDrop).not.toHaveBeenCalled();
  });

  it("stands down on Escape without writing", async () => {
    const onDrop = vi.fn();
    const drawer = mountDrawer(() => true, onDrop);
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    await held.over(drawer.element);
    await held.cancel();

    expect(onDrop).not.toHaveBeenCalled();
    expect(drawer.over).toBe(false);
  });
});

describe("useDeckDragging", () => {
  it("answers the deck in the air and nothing for a card", async () => {
    const view = renderHook(() => useDeckDragging());
    const { element } = mountTile(() => DECK);

    const held = await startPointerDrag(element);
    expect(view.result.current).toEqual(DECK);
    await held.cancel();
    expect(view.result.current).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -- src/features/decks/deckDrag.test.ts 2>&1 | tail -25`
Expected: the first test (`is refused by the card reader`) **passes** — it is arithmetic over two
pure functions and nothing in this task changes it. The five gesture tests fail on
`held.started` / `drawer.over`. If the first one fails, the key sharing has been broken and that
is a different bug.

- [ ] **Step 4: Migrate `deckDrag.ts`**

```ts
import { useCallback, useRef, type RefObject } from "react";
import { useDndDragging, useDndDropTarget, dndDraggable } from "@/lib/dndTarget";
```

`deckDraggable` loses its `let onControl` / `mousedown` / `canDrag` block entirely — that is the
capture-phase guard, and `lib/dndManager.ts` now configures `PointerSensor.preventActivation` with
`NOT_A_DRAG` once for the whole window. Keep the comment explaining *why* the guard exists (the
Delete button, the nearest-draggable-ancestor rule, the five pixels of travel) and change only the
sentence that says the library adds no exclusion of its own — it does now, and it is configured in
one place:

```ts
export function deckDraggable({
  element,
  payload,
}: {
  element: HTMLElement;
  /** Read at the press, so a tile renamed since it mounted carries what it is now. */
  payload: () => DeckDrag;
}): () => void {
  return dndDraggable({ element, data: () => deckDragData(payload()) });
}
```

`useDeckDragging` and `useDeckDropTarget` become the primitive:

```ts
export function useDeckDragging(): DeckDrag | null {
  return useDndDragging(readDeckDrag);
}

export function useDeckDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drag: DeckDrag) => boolean;
  onDrop: (drag: DeckDrag) => void;
}): boolean {
  // Only `over`, deliberately. Every folder-shaped target answers the same yes/no about a deck,
  // so the ring is raised once by the page from `useDeckDragging`'s payload rather than per
  // target — which is the split `wishDrag.ts` explains at length and which does **not** hold for
  // a wish or a collection entry, where the folder a row is already in refuses it.
  const { over } = useDndDropTarget({ ref, read: readDeckDrag, canDrop, onDrop });
  return over;
}
```

- [ ] **Step 5: Run, then rewrite the one HTML5 drag that was a deck**

```bash
npm run test -- src/features/decks/deckDrag.test.ts src/features/decks/DecksPage.test.tsx src/features/decks/FolderTree.test.tsx 2>&1 | tail -12
```

`DecksPage.test.tsx`'s `startDrag` at ~line 1814 carries a comment saying *"a deck is still a
pragmatic-dnd HTML5 drag"* — that comment is now false. Rewrite the test to `startPointerDrag`,
give the tile and the drawer boxes, and **rewrite the comment to say what the test now proves**
rather than deleting it: after this task the folder tree and the deck tile are on one library and
the claim that they cannot reach each other's handlers has to be made a different way — through
the two marks, which the first test in `deckDrag.test.ts` now holds.

Expected at the end: `Tests` at Step 1's numbers, plus the six new ones.

- [ ] **Step 6: Mutate the subject**

1. In `deckDraggable`, pass a static record — `data: () => deckDragData({ deckId: 12, name: "Burn" })`.
   **"carries the deck as it is at the press" must fail.**
2. In `useDeckDropTarget`, return `armed` instead of `over`. **"files a deck into the drawer it was
   let go over" must fail** on `drawer.over` being true before the pointer arrives — if it does
   *not* fail, the test is asserting `over` at a moment when armed and over agree, and it needs a
   second drawer the pointer never visits.
3. In `readDeckDrag`, drop the `data[MARK_KEY] !== DECK_MARK` check. **"is refused by the card
   reader, and refuses a card" must fail** on the second expectation.

**If any survives, stop and report.**

- [ ] **Step 7: Re-assert the drags this task did not touch**

```bash
npm run test -- src/lib/folderDrag.test.ts src/features/decks/categoryDrag.test.ts src/features/decks/DeckEditor.test.tsx src/features/collection/CollectionPage.test.tsx src/features/wishlist/WishlistPage.test.tsx src/components/AppShell.test.tsx 2>&1 | tail -8
```
Expected: unchanged and green. `FolderTree.tsx`'s row is the element to watch: it puts the deck
drop on the outer `ref` and the folder drag and drop on an inner `folderRef`, and those two boxes
are now both dnd-kit. `FolderTree.test.tsx`'s 14 tests and `DecksPage.test.tsx`'s two existing
`pointerDrag` calls are the evidence.

- [ ] **Step 8: Story plays**

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```
Expected: green. `DecksPage.stories.tsx` is imported eagerly by `src/stories.test.tsx` and draws
the gallery.

- [ ] **Step 9: Commit**

```bash
npm run verify > /tmp/verify-3b-3.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3b-3.log
git add src/features/decks/deckDrag.ts src/features/decks/deckDrag.test.ts src/features/decks/DecksPage.test.tsx src/features/decks/FolderTree.test.tsx
git commit -m "refactor(decks): filing a deck is a pointer gesture

The second independent payload. A deck's mark shares dnd.ts's key on purpose — so a card reader
refuses a deck and a deck reader refuses a card, in both directions rather than each ignoring the
other — and that fence is now the first test in a file this module has never had.

deckDraggable loses its capture-phase mousedown guard, which is a removal rather than a
regression: dndManager.ts configures PointerSensor.preventActivation with this app's own
NOT_A_DRAG once for the whole window, so the Delete button on a tile is refused by the library
instead of by a copy of the same rule per registration.

useDeckDropTarget still answers a bare boolean. Every folder-shaped target answers the same yes/no
about a deck, so the ring is the page's to raise from the payload — which is exactly what does not
hold for a wish or a collection entry, where the folder a row is already in refuses it.

DecksPage's one HTML5 drag said in a comment that a deck was still pragmatic-dnd. It is not, and
the claim that the two gestures cannot reach each other now rests on the marks rather than on the
libraries."
```

---

### Task 4: The multi-card count chip — `src/lib/dragPreview.ts`

**Files:**
- Modify: `src/lib/dragPreview.ts` (82 lines) — replace `setCardCountPreview` with a manager-driven chip
- Modify: `src/lib/dndManager.ts` — install it once, beside the `data-dragging` listeners
- Test: `src/lib/dragPreview.test.ts` (48 lines, 4 tests — all about `cardCountLabel`, which does not change)

**Interfaces:**
- Consumes: `dndManager`, `readDragGroup` from `@/features/decks/dnd`.
- Produces: `cardCountLabel` unchanged; `installCardCountPreview(manager)` replacing
  `setCardCountPreview(count, nativeSetDragImage)`.

> **Why this can be done before Task 5 and not inside it.** The chip reads the count off the
> payload — `readDragGroup(source.data).length` — rather than off a callback the source hands in,
> so it needs no cooperation from `composedDraggable` at all. That makes it testable *now*,
> against a hand-built `Draggable` carrying a `dragData(payload, rest)` record, and it takes the
> `count` plumbing out of `composedDraggable` before Task 5 has to rewrite that function. Until
> Task 5 lands there is no dnd-kit card source in the app, so the installed listener draws nothing
> in the shipped window — which is correct, because the pragmatic path is still drawing the native
> preview it always has.

> **What replaces `setCustomNativeDragPreview`, and why not dnd-kit's `Feedback`.** That plugin
> clones the source element into an overlay and positions it from `--dnd-*` custom properties; its
> `feedback` option takes `'default' | 'move' | 'clone' | 'none'` and nothing that means "and also
> draw this". Reaching into `Feedback.overlay` would be reaching into a plugin instance the manager
> exposes as a flat `Plugin<any>[]`, with no typed lookup. A chip this app owns outright — one
> `<div>`, `position: fixed`, moved from `operation.position.current` — depends on no library
> internals, survives an upgrade, and is drawn with **inline style attributes**, which
> `style-src-attr 'unsafe-inline'` permits and which is the half of the CSP that was never the
> problem. `index.css` gains nothing.

- [ ] **Step 1: Record the baseline**

```bash
npm run test -- src/lib/dragPreview.test.ts src/features/decks/dnd.test.ts 2>&1 | tail -8
```

- [ ] **Step 2: Write the failing tests**

Replace the body of `src/lib/dragPreview.test.ts` below its `cardCountLabel` describe — **keep
those four tests exactly as they are**, because `cardCountLabel` is pure and unchanged, and a task
that rewrites them has changed something it should not have.

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Draggable } from "@dnd-kit/dom";
import { dragData } from "@/features/decks/dnd";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { CARD_COUNT_CHIP, cardCountLabel } from "@/lib/dragPreview";
import { startPointerDrag } from "@/test-drag";

const CARDS = [
  { kind: "card", cardId: "a", name: "Sol Ring", typeLine: "Artifact" },
  { kind: "card", cardId: "b", name: "Arcane Signet", typeLine: "Artifact" },
  { kind: "card", cardId: "c", name: "Mind Stone", typeLine: "Artifact" },
] as const;

const undo: (() => void)[] = [];
afterEach(() => {
  while (undo.length) undo.pop()!();
});

function boxed(element: HTMLElement): HTMLElement {
  element.getBoundingClientRect = () =>
    ({
      x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 40, width: 200, height: 40,
      toJSON: () => ({}),
    }) as DOMRect;
  return element;
}

function mountSource(record: Record<string, unknown>): HTMLElement {
  const element = boxed(document.createElement("div"));
  element.textContent = "a card";
  document.body.append(element);
  const draggable = new Draggable(
    { id: dndId("chip-test"), element, data: record, register: false },
    dndManager,
  );
  registerNow(draggable);
  undo.push(() => {
    draggable.destroy();
    element.remove();
  });
  return element;
}

const chip = () => document.querySelector<HTMLElement>(`[${CARD_COUNT_CHIP}]`);

describe("the multi-card count chip", () => {
  it("draws nothing for a single-card drag", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0])));
    expect(chip()).toBeNull();
    await held.cancel();
  });

  it("draws the count for a drag carrying more than one", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1], CARDS[2]])));
    expect(chip()?.textContent).toBe(cardCountLabel(3));
    await held.cancel();
  });

  it("draws nothing for a drag that is not this app's card drag", async () => {
    const held = await startPointerDrag(mountSource({ folderSource: "something else" }));
    expect(chip()).toBeNull();
    await held.cancel();
  });

  /** It has to travel: a chip pinned where the drag began says nothing about where the cards are
   *  going, which is the one moment the reader can still change their mind. */
  it("follows the pointer", async () => {
    const held = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await held.moveTo(400, 300);
    const at = chip();
    expect(at?.style.left).toBe("412px");
    expect(at?.style.top).toBe("312px");
    await held.cancel();
  });

  it("is gone when the drag ends, dropped or cancelled", async () => {
    const dropped = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await dropped.drop();
    expect(chip()).toBeNull();

    const cancelled = await startPointerDrag(mountSource(dragData(CARDS[0], [CARDS[1]])));
    await cancelled.cancel();
    expect(chip()).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -- src/lib/dragPreview.test.ts 2>&1 | tail -20`
Expected: the four `cardCountLabel` tests pass; the file fails to import `CARD_COUNT_CHIP`.
Fixing the import alone would leave four failures on `chip()?.textContent`, which is the shape you
want before implementing.

- [ ] **Step 4: Implement**

Keep the whole "Why a drag needs to say this at all" and "Only for two or more" reasoning at the
top of `src/lib/dragPreview.ts` — it is about the gesture, not the library. Replace the "Plain DOM
rather than React" section's *mechanism* (it argues against a React root inside
`setCustomNativeDragPreview`'s one-microtask window, which no longer exists) with the reason the
chip is app-owned rather than the library's, and keep its conclusion about inline styles, which is
now a CSP fact rather than a timing one.

```ts
import type { DragDropManager } from "@dnd-kit/dom";
import { readDragGroup } from "@/features/decks/dnd";

/** The attribute the chip carries, so a test can find it and nothing else can be mistaken for
 *  it. Not a class: the chip is drawn with inline styles for the reason above, and a class the
 *  stylesheet does not define would be a name meaning nothing. */
export const CARD_COUNT_CHIP = "data-drag-count";

const OFFSET = { x: 12, y: 12 };

export function cardCountLabel(count: number): string {
  return `${count} ${count === 1 ? "card" : "cards"}`;
}

/**
 * Draw the count chip for a drag carrying two or more cards, for as long as it is in the air.
 *
 * **The count comes off the payload, not off the source.** `dnd.ts`'s `dragData` already writes
 * every member of a multi-select drag under its group key and `readDragGroup` reads them back, so
 * there is nothing for a call site to pass and nothing for one to get wrong. A drag this app did
 * not put in the air reads as no cards and draws nothing.
 *
 * Installed once, from `lib/dndManager.ts`, beside that module's own `data-dragging` listeners
 * and for the same reason: the manager is a singleton with no teardown, so its subscriptions are
 * the window's rather than something a component owns and could forget. The cleanup is returned
 * anyway, because a subscription with no way out is a subscription a test cannot isolate.
 */
export function installCardCountPreview(manager: DragDropManager): () => void {
  let chip: HTMLElement | null = null;

  const place = (at: { x: number; y: number }) => {
    if (!chip) return;
    chip.style.left = `${at.x + OFFSET.x}px`;
    chip.style.top = `${at.y + OFFSET.y}px`;
  };

  const off = [
    manager.monitor.addEventListener("dragstart", ({ operation }) => {
      const count = operation.source ? readDragGroup(operation.source.data).length : 0;
      // Below two keeps the drag exactly as it was: the preview is a picture of the card, which
      // is better than any chip could be, and `1 card` tells the reader what they can see.
      if (count < 2) return;
      chip = document.createElement("div");
      chip.setAttribute(CARD_COUNT_CHIP, "");
      chip.setAttribute("aria-hidden", "true");
      chip.textContent = cardCountLabel(count);
      Object.assign(chip.style, {
        position: "fixed",
        // Above the drag preview, which the library gives `z-index: calc(infinity)` — clamped by
        // the engine to 2147483647, measured in the built app on 2026-08-27. There is nothing
        // above that, so the chip is drawn *after* it in the document instead and wins on order.
        zIndex: "2147483647",
        pointerEvents: "none",
        // The app's own gold on the app's own felt, read from the stylesheet rather than copied:
        // `var()` with a fallback is correct whether or not the custom properties have reached an
        // element appended straight to `document.body`.
        background: "var(--color-bg, oklch(0.16 0.01 270))",
        color: "var(--color-accent, oklch(0.75 0.12 85))",
        border: "1px solid var(--color-accent, oklch(0.75 0.12 85))",
        borderRadius: "6px",
        padding: "3px 8px",
        font: "600 12px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
        whiteSpace: "nowrap",
      });
      document.body.append(chip);
      place(operation.position.current);
    }),
    manager.monitor.addEventListener("dragmove", ({ operation }) => {
      place(operation.position.current);
    }),
    // Dropped or cancelled — the library ends both the same way, so the chip goes without this
    // hearing an Escape.
    manager.monitor.addEventListener("dragend", () => {
      chip?.remove();
      chip = null;
    }),
  ];

  return () => {
    for (const stop of off) stop();
    chip?.remove();
    chip = null;
  };
}
```

In `src/lib/dndManager.ts`, under the two existing `dragstart`/`dragend` listeners:

```ts
import { installCardCountPreview } from "@/lib/dragPreview";

/**
 * The multi-card count chip, armed for the life of the window.
 *
 * Here rather than in `dragPreview.ts`'s own module scope because that module must not import
 * this one — it takes the manager as an argument precisely so the dependency runs one way and a
 * test can install a chip against a manager of its own.
 */
installCardCountPreview(dndManager);
```

- [ ] **Step 5: Run, and check the position assertion is not lying**

Run: `npm run test -- src/lib/dragPreview.test.ts 2>&1 | tail -12`
Expected: 9 passed.

**"follows the pointer" is the assertion most likely to be vacuous**, because
`dragOperation.position.current` lags one `pointermove` behind and `startPointerDrag`'s `move`
dispatches twice for exactly that reason. If it passes on the first run, temporarily change
`place`'s `at.x + OFFSET.x` to `at.x` and confirm it fails on `412px`. If it does **not** fail,
the chip is not being placed from the pointer at all and the test is reading a default.

- [ ] **Step 6: Mutate the subject**

1. Change `if (count < 2) return;` to `if (count < 1) return;`. **"draws nothing for a
   single-card drag" must fail.**
2. Delete the `dragend` listener's `chip?.remove()`. **"is gone when the drag ends" must fail** on
   the cancelled half.
3. Replace `readDragGroup(operation.source.data).length` with a constant `3`. **"draws nothing for
   a drag that is not this app's card drag" must fail.**

**If any survives, stop and report.**

- [ ] **Step 7: Re-assert everything that draws a drag**

```bash
npm run test -- src/features/decks/dnd.test.ts src/features/decks/DeckEditor.test.tsx src/features/decks/views/views.test.tsx src/lib/folderDrag.test.ts 2>&1 | tail -8
```
Expected: unchanged. `composedDraggable` still passes `onGenerateDragPreview` to pragmatic-dnd and
`dnd.test.ts` still covers it — **that plumbing is not removed here**, because removing it before
Task 5 would leave the shipped multi-card drag with no chip at all for one commit. It comes out in
Task 5's Step 4.

- [ ] **Step 8: Story plays**

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```
Expected: green.

- [ ] **Step 9: Commit**

```bash
npm run verify > /tmp/verify-3b-4.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3b-4.log
git add src/lib/dragPreview.ts src/lib/dragPreview.test.ts src/lib/dndManager.ts
git commit -m "feat(dnd): the count chip is the app's, drawn off the manager

setCustomNativeDragPreview goes with the library that had it. What replaces it is one div the app
owns outright, position: fixed, moved from the operation's own coordinate — which depends on no
plugin internals, survives a dnd-kit upgrade, and is drawn with inline style attributes, the half
of the CSP that was never the problem.

Not dnd-kit's Feedback: that plugin clones the source into an overlay and its feedback option
takes four words, none of which mean 'and also draw this'. Reaching for its overlay would be
reaching into an instance the manager exposes as a flat array with no typed lookup.

The count now comes off the payload rather than off a callback the source hands in, because
dragData already writes every member of a multi-select drag and readDragGroup reads them back. So
there is nothing for a call site to pass and nothing for one to get wrong — and it made this
testable before composedDraggable moved, against a hand-built source.

composedDraggable's onGenerateDragPreview stays for one more commit. Taking it out now would leave
the shipped multi-card drag with no chip at all until the source moves."
```

---

### Task 5: The card payload — every source and every reader, in one commit

**Files (production):**
- Modify: `src/features/decks/dnd.ts` — `composedDraggable` only; the pure half is untouched
- Modify: `src/features/decks/cardControl.tsx` — `useCategoryDrop`
- Modify: `src/features/decks/QuickZones.tsx` — the `QuickZones` monitor and `QuickZone`'s target
- Modify: `src/features/decks/PriceStrip.tsx` — the monitor and the remove tray
- Modify: `src/features/decks/DeckEditor.tsx` — delete the `autoScrollForElements` effect (~line 2591)
- Modify: `src/components/AppShell.tsx` — the sidebar entry's target (~line 528)
- Modify: `src/components/useSidebarDrops.ts` — the monitor
- Modify: `src/features/collection/collectionDrag.ts` — both draggables and `useCollectionDropTarget`
- Modify: `src/features/wishlist/wishDrag.ts` — `wishDraggable` and `useWishDropTarget`

**Files (tests — every file that calls `startDrag`, `dragOnto` or `fireDragEvent` and is not a
category or deck drag):** `src/features/collection/CollectionPage.test.tsx` (14 calls),
`src/features/decks/DeckEditor.test.tsx` (13), `src/features/collection/CollectionFolderCard.test.tsx` (13),
`src/features/wishlist/WishFolderCard.test.tsx` (9), `src/features/decks/views/views.test.tsx` (4 remaining),
`src/features/wishlist/WishlistPage.test.tsx` (8), `src/features/tags/TagsPage.test.tsx` (3),
`src/features/search/SearchPage.test.tsx` (3), `src/features/search/CardGrid.test.tsx` (3),
`src/features/decks/DeckSearchPanel.test.tsx` (3), `src/features/card/CardDetailPane.test.tsx` (3),
`src/components/AppShell.test.tsx` (3), `src/features/decks/QuickZones.test.tsx` (2),
`src/features/wishlist/WishlistGrid.test.tsx` (1), `src/features/collection/collectionDrag.test.ts` (1),
`src/features/card/PrintingPreview.test.tsx` (1), `src/features/wishlist/wishDrag.test.ts`,
`src/features/decks/cardControl.test.ts`

**Files (stories — each carries its own copy of the HTML5 helper, because `src/test-drag.ts`
registers a vitest `afterEach` at import time and cannot go into a browser bundle):**
`src/components/AppShell.stories.tsx`, `src/features/decks/QuickZones.stories.tsx`,
`src/features/collection/CollectionFolderCard.stories.tsx`,
`src/features/wishlist/WishFolderCard.stories.tsx`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: every export in every file above with **the signature it has today**. `composedDraggable`
  loses its `count` option (Task 4 took the count off the payload) and `cardDraggable` loses the
  `count: rest ? … : undefined` line that fed it; nothing else in any signature moves.

> **This is one commit and it cannot be fewer.** See "The finding that decides how this plan is
> cut" above: one `composedDraggable` is the sole source behind every card, tile, row and wish, its
> record carries up to three marks at once, and dual-registering the two libraries on one element
> is not viable because dnd-kit's `PointerSensor` capture-phase `preventDefault`s the native
> `dragstart` whenever the press landed on a child. Nine production files, eighteen test files and
> four story files change together. Budget accordingly, and do not start it in the same session as
> another task.

> **Two things about this task are new rather than a repeat of the pattern**, and both are called
> out at their step: the overlay targets need `collisionPriority`, and the deck editor's
> auto-scroller is deleted rather than ported.

- [ ] **Step 1: Record the baseline, in full**

```bash
npm run test:run > /tmp/baseline-3b-5.log 2>&1; grep -E "Test Files|Tests " /tmp/baseline-3b-5.log
```
The whole suite, because this task touches every file that drags anything. Write the two numbers down. Do
not pipe it to `tail` and read an exit code from the pipe — `verify`'s exit code lies through a
pipe, and so does this one.

- [ ] **Step 2: Migrate `composedDraggable`**

This is the seam everything else hangs off, so it goes first and alone.

```ts
import { dndDraggable } from "@/lib/dndTarget";
import type { DeckFinish } from "@/lib/ipc";
```

`setCardCountPreview` is gone from the imports — Task 4 moved the chip onto the manager, and it
reads the count off the payload this function already writes.

```ts
export function composedDraggable({
  element,
  data,
  notFrom = NOT_A_DRAG,
}: {
  element: HTMLElement;
  /** Read at the press, so a row that has been renumbered — or re-filed — since it mounted still
   *  carries what it is now. */
  data: () => Record<string, unknown>;
  /** Overridable for the one case where the default is wrong — nothing today. */
  notFrom?: string;
}): () => void {
  return dndDraggable({
    element,
    data,
    // The press guard, per source, for the one caller that ever narrows it. The app-wide rule is
    // `dndManager.ts`'s `PointerSensor.preventActivation`, which is this same selector said once;
    // a source that passes its own gets its own sensor rather than the shared one.
    ...(notFrom === NOT_A_DRAG
      ? {}
      : {
          sensors: [
            PointerSensor.configure({
              preventActivation: (event) =>
                event.target instanceof Element && event.target.closest(notFrom) !== null,
            }),
          ],
        }),
  });
}
```

Keep the whole doc comment. The paragraph about the stepper bug of 2026-08-05 and the four copies
of Abandon Attachments is still why the guard exists; the paragraph explaining that "the drag
library adds no exclusion of its own" is now false and must be rewritten to point at
`dndManager.ts`, which says the same rule once for the window. The paragraph about why this takes
a bare record rather than a `DragPayload` — the wishlist tile being two things at once, and a
second registration on one element giving one tile two competing registrations — needs its second
half corrected: dnd-kit **does** allow two registrations on one element, so the reason composing
happens in the caller is now the first half alone (widening `DragPayload` would put a wishlist
concept inside the deck drag's type), and that is still enough.

Then delete the `count` option from `cardDraggable`'s call:

```ts
  return composedDraggable({
    element,
    data: () => dragData(payload(), rest?.() ?? []),
    notFrom,
  });
```

`rest` stays exactly as it is — it is what writes the group into the record, which is what the
chip now reads.

- [ ] **Step 3: Migrate the deck editor's four readers**

`cardControl.tsx`'s `useCategoryDrop` — the `attach` bridge is Task 2's, in this file's own
`attach`-not-`ref` idiom:

```ts
export function useCategoryDrop(categoryId: number | null, onDrop?: (writes: DeckWrite[]) => void) {
  const enabled = categoryId !== null && onDrop !== undefined;
  const ref = useRef<HTMLElement | null>(null);

  // "At least one member writes" — `dropWrites`' rule, which for a single-card drag is the same
  // question `dropWrite(…) !== null` asked before groups existed. Asked twice: once so a drop
  // that would mean nothing never lights up, and again on the drop, because the two questions can
  // be a second apart and only the second one writes.
  const writesFor = useCallback(
    (payloads: DragPayload[]) =>
      categoryId === null ? [] : dropWrites(payloads, { kind: "category", categoryId }),
    [categoryId],
  );
  const { armed, over } = useDndDropTarget({
    ref,
    read: readDragGroup,
    canDrop: (payloads) => writesFor(payloads).length > 0,
    onDrop: (payloads) => onDrop?.(writesFor(payloads)),
  });

  const attach = useCallback((element: HTMLElement | null) => {
    ref.current = element;
    return () => {
      ref.current = null;
    };
  }, []);

  return { attach, over: over && enabled, eligible: armed && enabled };
}
```

> **`read: readDragGroup` is not `read: readDragData`, and the difference is load-bearing.**
> `readDragGroup` answers *every* card the drag is carrying — one entry for an ordinary drag,
> several for a multi-select, and an **empty array** for something that is not this app's card
> drag. `useDndDropTarget` treats `null` as "not mine", so a reader returning `[]` would arm on a
> folder drag. Wrap it:
> ```ts
> const readCards = (data: Record<string, unknown>): DragPayload[] | null => {
>   const cards = readDragGroup(data);
>   return cards.length === 0 ? null : cards;
> };
> ```
> Put `readCards` in `dnd.ts` beside `readDragGroup`, export it, and give it a test in
> `dnd.test.ts` asserting `readCards(folderDragData(…))` is `null` while `readDragGroup` of the
> same record is `[]`. Every card reader in this task uses it. **This is the single most likely
> place for a silent bug in this task**: a target that arms on a folder drag looks fine in every
> test written for cards.

`QuickZones.tsx` — the monitor becomes `useDndDragging(readDragData)`, and `QuickZone`'s target
becomes the primitive **with a priority**:

```ts
import { CollisionPriority } from "@dnd-kit/abstract";
…
const { over } = useDndDropTarget({
  ref,
  read: (data) => (latest.current.accepts(data) ? data : null),
  canDrop: () => true,
  onDrop: (data) => latest.current.drop(data),
  // **The bar is drawn on top of the deck and dnd-kit does not care.** Its collision detector
  // scores a hit as one over the distance to the droppable's *centre*, so a short bar sitting on
  // a tall pile does not reliably win — `LAYER.dragTray`'s z-index decides what is painted and
  // nothing about what is hit. This is what puts the zone the reader is aiming at in front of the
  // pile behind it.
  collisionPriority: CollisionPriority.Highest,
});
```

`PriceStrip.tsx` — the same two moves. The monitor is
`useDndDragging((data) => { const card = readDragData(data); return card?.kind === "deck-card" ? card : null; })`,
which keeps the narrowing that stops a panel tile from re-rendering the strip mid-drag; the tray is
the primitive with `read: readCards`, `canDrop`/`onDrop` over `dropWrites(payloads, { kind: "remove" })`,
and `collisionPriority: CollisionPriority.Highest`. Keep the comment about the tray only existing
during a drag and being picked up on the next `dragover` — **and check it is still true**: dnd-kit
registers a `Droppable` when the effect runs and `collisionObserver` re-measures on the next
collision pass, so a tray that appears at `dragstart` is collidable from the next pointer move.
Say which of the two it now is, measured from the test rather than assumed.

`DeckEditor.tsx` — delete the effect at ~line 2591 and its import:

```ts
// Deleted: `autoScrollForElements({ element })` on the editor's scroller.
```

> **`AutoScroller` is already installed.** `defaultPreset.plugins` in `@dnd-kit/dom` is
> `[Accessibility, AutoScroller, Cursor, Feedback, PreventSelection]`, and `dndManager.ts` filters
> only `Accessibility` out — so the auto-scroller has been in the manager since 3a, scrolling by
> default within 20% of a scrollable container's edge with an acceleration of 25. Keep the comment
> that records *which* scroller was registered and which was deliberately not (the `VirtualTable`
> one, one element further in), rewritten to say that the choice is now the library's `Scroller`
> walking real scrollable ancestors rather than an element this file named — and **that is a
> behaviour change to verify in Task 6**, not something to assert from a plugin list.

`AppShell.tsx`'s sidebar entry — the primitive with `read: readCards` and a `canDrop` that keeps
today's `taken(source.data).length > 0` meaning. The existing comment ("No `getData`: what a drop
writes is decided by the entry") stands.

`useSidebarDrops.ts`'s monitor — `const dragging = useDndDragging(readDragData) !== null;`. The
comment about `onDrop` firing for a cancelled drag as well as a completed one stays true and now
belongs to the primitive, so point at it rather than repeating it.

- [ ] **Step 4: Migrate the collection and the wishlist**

`collectionDrag.ts` — `collectionDraggable` and `collectionTileDraggable` are unchanged in body:
both already delegate to `composedDraggable`, which moved in Step 2. `useCollectionDropTarget`
becomes:

```ts
export function useCollectionDropTarget({
  ref,
  canDrop,
  onDrop,
}: {
  ref: RefObject<HTMLElement | null>;
  canDrop: (drop: CollectionDrop) => boolean;
  onDrop: (drop: CollectionDrop) => void;
}): { armed: boolean; over: boolean } {
  return useDndDropTarget({ ref, read: readCollectionDrop, canDrop, onDrop });
}
```

`wishDrag.ts`'s `useWishDropTarget` is the same with `readWishDrag`. **Both keep their whole doc
comments** — the argument about why `armed` is per target rather than shared with `deckDrag.ts`'s
split, and why the two hooks are one hook here, is about the *data* and survives the library
entirely.

> **The two folder cards are where two `Droppable`s land on one rectangle.**
> `CollectionFolderCard.tsx` puts `useCollectionDropTarget` on the `<li ref={ref}>` and
> `useFolderDropTarget` on an inner `<div ref={slot}>`; `WishFolderCard.tsx` mirrors it. After this
> step both are dnd-kit. **Do not merge them onto one element** — every existing test and story
> addresses those two boxes by name, and the nesting is what makes the `⋯` corner part of the
> folder target. But **rewrite both comments**: they currently say pragmatic-dnd keeps one drop
> target per element and a second `set` replaces the first, which is no longer the reason. The
> reason now is that `computeCollisions` skips any droppable whose `accepts(source)` is false
> before it measures, so the two coexist because `readCollectionDrop` and `readFolderDrag` are
> disjoint — and the nesting is kept for the geometry and for the tests, not for the registry.

- [ ] **Step 5: Compile, then take the suite one file at a time**

```bash
npx tsc --noEmit 2>&1 | tail -20
```
Fix every type error before running a test. Then, in this order — each one is a smaller blast
radius than the next:

```bash
npm run test -- src/features/decks/dnd.test.ts src/features/decks/cardControl.test.ts src/features/wishlist/wishDrag.test.ts src/features/collection/collectionDrag.test.ts 2>&1 | tail -10
npm run test -- src/features/decks/QuickZones.test.tsx src/features/decks/views/views.test.tsx 2>&1 | tail -10
npm run test -- src/features/decks/DeckEditor.test.tsx src/features/decks/DeckSearchPanel.test.tsx 2>&1 | tail -10
npm run test -- src/features/collection src/features/wishlist 2>&1 | tail -10
npm run test -- src/features/search src/features/tags src/features/card 2>&1 | tail -10
npm run test -- src/components/AppShell.test.tsx 2>&1 | tail -10
```

Every `startDrag`, `dragOnto` and `fireDragEvent` call in the card payload's tests becomes
`startPointerDrag` / `pointerDrag`, and **every source and every target in those tests needs a
`getBoundingClientRect`**. That is the whole difference between the two harnesses and it is where
the time goes: under pragmatic-dnd a test named the element and the library found it with
`closest`; here the pointer really travels and an element with no box is invisible. `folderDrag.test.ts`'s
`boxed` helper is the shape to copy. Do not put a copy of it in eighteen files — put it in
`src/test-drag.ts` beside the pointer helpers, exported, with a comment saying it exists because
jsdom has no layout engine and dnd-kit hit-tests by coordinate.

> **`dragOnto(source, target)` has a one-line replacement and `startDrag` does not.**
> `pointerDrag(from, to)` is the whole gesture; the `startDrag(...).over(...).drop()` shape maps to
> `startPointerDrag(...)` and its `over`/`drop`/`cancel`, but `over` now takes an optional
> `{ x?, y? }` fraction and `leave()` goes to a fixed far-away point rather than to
> `document.body`. Read `src/test-drag.ts`'s `PointerHeld` interface before rewriting a file.

- [ ] **Step 6: The four story files**

Each carries its own `StoryDataTransfer`, `send`, `frame` and `pickUp`. Replace all four with a
pointer helper of the same shape — and note the two things a story needs that a test does not:

1. **A story cannot import `src/test-drag.ts`** (it registers a vitest `afterEach` at import time
   and pulls in `@testing-library/react`, which would put a test runner in the browser bundle).
   The copies stay copies. Say so in each, as they already do.
2. **A story that walks away holding a dnd-kit drag leaves the manager's operation non-idle**, and
   `handlePointerDown` returns early unless the status is idle — so the *next* story cannot pick
   anything up. The vitest side is covered by `test-drag.ts`'s `afterEach`, which dispatches an
   Escape at the body when `dndManager.dragOperation.status.idle` is false. **A story has no
   `afterEach`**, so each of the four keeps its existing `finally` and that `finally` now presses
   Escape at `document.body` rather than firing `dragend` at `window`.

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -12
```
Expected: green, at Step 1's story count.

- [ ] **Step 7: Mutate, in the four places this task can go silently wrong**

1. In `dnd.ts`, make `readCards` return `readDragGroup(data)` unwrapped (so `[]` rather than
   `null`). **A test in `dnd.test.ts` must fail** — write it if it does not exist: a folder payload
   through `readCards` is `null`, and a `useCategoryDrop` mounted over a folder drag is not armed.
2. Delete `collisionPriority` from `QuickZone`. **A test in `QuickZones.test.tsx` must fail** —
   write it if it does not exist: a zone and a category target given *overlapping* boxes, with the
   pointer inside both, must drop on the zone. Give the category the larger box so that
   `1 / distance-to-centre` favours the zone only when priority is doing the work, and say so in
   the test's comment.
3. In `useCollectionDropTarget`, swap `readCollectionDrop` for `readCollectionDrag`. **A test
   about dropping a *tile* on a folder must fail**, in `CollectionPage.test.tsx` or
   `CollectionFolderCard.test.tsx`.
4. In `composedDraggable`, pass `data()` once rather than the callback. **"carries the row as it is
   at the press" must fail** in whichever of `collectionDrag.test.ts` / `wishDrag.test.ts` /
   `dnd.test.ts` asserts it — and if none of the three does, that is a gap this task must close
   before it commits, because the read-at-press rule is what lets a folder refuse a row already
   filed in it.

**Report any that survives and stop.**

- [ ] **Step 8: Prove nothing is left registered with the old library**

```bash
grep -rn 'from "@atlaskit' src/ .storybook/
```
Expected: **nothing at all.** The grep is written against `from "@atlaskit` — the import statement
— rather than against the package name, because eleven files mention pragmatic-dnd in a doc
comment as history (`src/lib/focus.ts`, `src/features/decks/DropIndicator.tsx`,
`src/features/decks/formFields.ts` and more) and those mentions stay. Any line this returns is a
registration this task missed, and the app has a payload with a reader on the wrong library.

```bash
grep -rn 'startDrag\|dragOnto\|fireDragEvent' src/ | grep -v 'src/test-drag.ts'
```
Expected: zero. Every HTML5 call site is gone; only the helpers themselves remain, and 3c deletes
those.

- [ ] **Step 9: Re-assert the two payloads this task did not touch**

```bash
npm run test -- src/lib/folderDrag.test.ts src/lib/dndTarget.test.ts src/features/decks/categoryDrag.test.ts src/features/decks/deckDrag.test.ts 2>&1 | tail -8
```
Expected: unchanged and green. Every element in the app is now on one library, so this is the run
where a `Droppable` that arms on the wrong payload finally has something to collide with.

- [ ] **Step 10: The whole suite, against Step 1**

```bash
npm run test:run > /tmp/after-3b-5.log 2>&1; grep -E "Test Files|Tests " /tmp/after-3b-5.log
```
The `Tests` total will be **higher** than Step 1's, by however many the mutation steps added.
It must not be lower, and no file may have fewer tests than it had. Diff the two logs' per-file
lines if the totals disagree by anything you cannot name.

- [ ] **Step 11: Commit**

```bash
npm run verify > /tmp/verify-3b-5.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3b-5.log
git add -A src/
git commit -m "refactor(dnd): the card payload moves to @dnd-kit/dom, whole

One commit because it cannot be fewer. composedDraggable is the single draggable behind every
card, row, tile and wish in the app, and its record carries up to three marks at once — so the
moment it becomes a dnd-kit Draggable, every reader of that record has to be a dnd-kit Droppable
in the same commit: the deck's piles, the quick zones, the remove tray, both sidebar entries,
every collection folder and every wishlist folder.

Bridging with both libraries on one source was measured and refused. PointerSensor binds a
capture-phase dragstart listener that preventDefaults the native drag whenever the press landed
on something that is not itself draggable — which in this app is almost every press, because a
card's name is a button and a tile's art is a button. The pragmatic drag would have died on
exactly the gestures a test for either library would not be watching.

Two things here are not a repeat of the pattern. The quick zones and the remove tray carry a
collisionPriority, because dnd-kit resolves overlap by distance to a droppable's centre and knows
nothing about z-index — a bar painted over a pile does not reliably win. And the deck editor's
autoScrollForElements is deleted rather than ported: AutoScroller has been in the manager's plugin
list since 3a.

readCards is new and is the quiet one. readDragGroup answers an empty array for a payload that is
not this app's card drag, and an empty array is not null — a target reading it directly would arm
on a folder. Every card reader goes through the wrapper.

The two folder cards now carry two Droppables on one rectangle, and that is legal: computeCollisions
skips any droppable whose accepts() is false before it measures. The nested boxes stay, for the
geometry and for the tests that address them, but the comments saying the registry is why are
corrected."
```

---

### Task 6: Drive every migrated drag in the real window

**Files:** none until Step 6 — this task produces measurements.

**Interfaces:**
- Consumes: Tasks 2–5.
- Produces: a live-verification section appended to
  `docs/reference/decks-live-findings.md`, and any correction the pass forces on
  `docs/reference/frontend-design.md`'s `## Drag and drop`.

> **3a proved one drag in the shipped window and called it the payoff.** This is the rest of them.
> Four things below cannot be reached from jsdom at all and are the whole reason this task exists:
> the auto-scroller (it measures rectangles), the overlap between the quick-zone bar and the pile
> under it (jsdom's boxes are the ones the test wrote), the drag preview `Feedback` clones, and
> the count chip's position against a real pointer.

- [ ] **Step 1: Take the app lock and start the app**

Follow the `running-the-app` skill. **Only one app runs across every worktree and the collision is
silent** — a second exits 0 with no window and no stderr. A `FREE` lock does not prove no app is
running; check for another worktree's `tauri`/`cargo`/`rustc` before claiming it.

- [ ] **Step 2: Drive the four gestures the suite can only approximate**

Use `scripts/cdp.mjs` per [the contract](../../reference/live-ui-verification.md). **`cdp.mjs drag`
cannot drive any of these** — it waits on `Input.dragIntercepted`, which only fires for a native
HTML5 drag, and there are none left in the app. `pull` is a real press/move/release and is the one
to reach for; it is absent from that script's own usage string.

1. **A card from the search panel onto a category column**, then onto the quick-zone bar while the
   bar overlaps a pile. Assert which target took it. This is `collisionPriority` in the only
   environment that can refute it.
2. **A multi-card drag**: Ctrl-click three rows, drag, and sample the chip's `textContent` and its
   rect per frame against the pointer's.
3. **A card dragged to the bottom of a long deck**, to see whether the editor auto-scrolls now that
   the explicit `autoScrollForElements` is gone and `AutoScroller` is doing it. Record what
   actually happens, including "it does not", which is a finding rather than a failure of this
   pass.
4. **A pile moved past its neighbours by its grip**, and a **deck filed into a folder** — the two
   payloads Tasks 2 and 3 migrated, which have never been drivable in the live window at all.

Two traps that have each cost a session: **`cdp.mjs click` needs a `hover --rest 200` first** —
a cold pointer makes the next action a no-op that still prints success — and **clicking and
reading in one `eval` answers about the frame before React re-rendered**, so split every drop and
its assertion into two calls.

- [ ] **Step 3: Assert each write reached the backend**

For each of the five, re-read the state in a **second** eval, then reload the window and read it
again. A reorder that only moved React state looks identical to one that reached SQLite until you
reload.

- [ ] **Step 4: Check the two things only a built app can show**

`tauri dev` sends **no CSP at all** — Vite serves the page and Tauri is out of the response path,
so `devCsp` is irrelevant there rather than merely permissive. The copied `@dnd-kit` rules in
`src/index.css` are only under test in a packaged binary. Build one:

```bash
npm run tauri build -- --debug --no-bundle
```
and repeat gestures 1 and 2 in it. Confirm the drag preview is `position: fixed` at the `--dnd-top`
/ `--dnd-left` the library writes inline, that `<html>` carries `data-dragging` through the gesture
and not after it, and that the count chip is drawn — the chip's styles are inline **attributes**,
which `style-src-attr 'unsafe-inline'` permits, and this is the pass that proves the distinction
held for a second element.

- [ ] **Step 5: Record what the pass found**

Append to `docs/reference/decks-live-findings.md`: the date, the build (debug or release — the same
measurement can differ by ~8×), what was driven, what was asserted, and every behaviour that
differs from the suite. **Name the auto-scroll answer plainly** whichever way it went.

Then correct `frontend-design.md`'s `## Drag and drop` section wherever this pass contradicts it —
that section was written from a spike and one domain, and it is now describing seven. **Three
things in it were already wrong before this pass, found on 2026-08-28 by reading it against the
code, and this is the commit that fixes them:**

- **Its "What jsdom cannot do" item 5 describes a fix that did not ship.** It says the ancestor
  clamp is unblocked by "giving `document.body` a viewport-sized `getBoundingClientRect` — and
  every ancestor between the target and the body needs one too". `src/test-setup.ts` does no such
  thing: it overrides `window.getComputedStyle` to answer `visible` wherever jsdom answers the
  empty string for `overflow`/`overflowX`/`overflowY`, so no ancestor counts as clipping and no
  rect is needed. That is a better fix and a different one, and the doc records the spike's
  finding rather than the code's.
- **`src/test-drag.ts`'s own comment repeats it**, saying "`test-setup.ts` gives `<body>` the
  viewport for that reason" and then telling the reader that "a scrolling box between a target and
  the body still needs a rect of its own". Neither sentence is true of the shipped shim. Fix it in
  the same commit; a harness that lies about what it does costs the next person a session.
- **The section is titled "what `@dnd-kit/react` 0.5.0 actually requires" and documents
  `@dnd-kit/dom`.** Nothing in `src/` imports `@dnd-kit/react`. Retitle it.

One more, in a file this task does not otherwise touch:
`src/features/collection/CollectionFolderCard.stories.tsx`'s `FolderTarget` story says the card
carries two drop targets on two boxes because "`@atlaskit/pragmatic-drag-and-drop` keeps one
element drop target per element and a second registration silently replaces the first". Since 3a
the folder target on that card is dnd-kit's, so that has not been the reason for some time —
`WishFolderCard.stories.tsx` carries the same sentence. Task 5 rewrites both comments where it
rewrites those files' helpers; if it did not, do it here.

- [ ] **Step 6: Release the app lock and commit**

```bash
git add docs/reference/decks-live-findings.md docs/reference/frontend-design.md src/test-drag.ts
git commit -m "docs(decks): every migrated drag, driven in the real window

3a proved one gesture and called it the payoff; this is the rest of them. Four of these cannot be
reached from jsdom at all: the auto-scroller measures rectangles, the overlap between the quick
zone bar and the pile under it is decided by boxes a test wrote, the drag preview is a clone the
library animates, and the count chip's position is only honest against a real pointer.

Two of the five have never been drivable in the live window in this app's history — moving a pile
by its grip and filing a deck into a folder were both native HTML5 drags, which Chromium refuses
to start from a synthetic event.

Repeated in a tauri build --debug binary for the two that depend on the shipped CSP, because
tauri dev sends no policy at all and cannot refute anything about it.

Three things in the reference doc were already wrong and are fixed here rather than added to. It
described the jsdom ancestor clamp as fixed by giving <body> a viewport rect; what shipped is a
getComputedStyle override answering `visible` where jsdom answers the empty string, which is a
better fix and a different one. test-drag.ts's own comment repeated the claim and told the reader
a scrolling box still needs a rect of its own — neither is true of the shim that exists. And the
section was titled after @dnd-kit/react while documenting @dnd-kit/dom, which nothing imports."
```

---

## Self-Review

**Spec coverage.** Implements spec §6.4's "desktop-first, every shipped drag re-verified" for
every domain 3a did not take. What is deliberately left for 3c: the two `package.json` lines, the
HTML5 half of `src/test-drag.ts`, and the `Accessibility` plugin decision 3a deferred.

**Where this plan disagrees with its brief, and why.** The brief named six domains. Thirteen files
hold a registration, and the six are not independent: `collectionDrag`, `wishDrag` and every card
target hang off one `composedDraggable`. The dual-registration bridge that would have let them
migrate separately is refused on a measurement from the library's own source
(`PointerSensor.handlePointerDown`'s capture-phase `dragstart` listener), not on a guess. So Task 5
is one commit across nineteen files and the plan says so rather than pretending to a grain the code
does not have. Tasks 1–4 exist to make Task 5 as small as it honestly can be.

**Placeholders.** None. Every step names the file, the symbol and the assertion. Task 5's Step 5
does not spell out eighteen test-file rewrites line by line — it gives the mechanical rule
(`startDrag` → `startPointerDrag`, every source and target needs a `getBoundingClientRect`, the
`boxed` helper moves into `test-drag.ts`), the two shape differences in `PointerHeld` that a
rewriter will hit, and a per-file run order. That is a transformation with a stated invariant, not
a placeholder.

**Type consistency.** `useDndDropTarget<T>` is defined in Task 1 and used with `readCategoryDrag`
(Task 2, `T = number`), `readDeckDrag` (Task 3, `T = DeckDrag`), `readCards` (Task 5,
`T = DragPayload[]`), `readCollectionDrop` and `readWishDrag` (Task 5). `useDndDragging<T>` is used
with `readDeckDrag` and `readDragData`. `dndDraggable` is used by `useCategoryDragSource`,
`deckDraggable` and `composedDraggable`, and its `handle` and `sensors` options each have exactly
one caller, named at the site that needs them. Every public signature in every migrated module is
unchanged except `composedDraggable`, which loses `count` because Task 4 moved the count onto the
payload — and `cardDraggable`, its only caller for that option, is edited in the same step.

**Every symbol here was read out of the post-3a tree on 2026-08-28**, not recalled:
`composedDraggable({ element, data, notFrom, count })`, `cardDraggable({ element, payload, notFrom, rest })`,
`readDragGroup` answering `[]` rather than `null`, `useCategoryDrop` returning `{ attach, over, eligible }`,
`useCategoryReorderDrop` returning the same three, `useCategoryDragSource` returning
`{ attachSource, attachHandle }`, `useDeckDropTarget` returning a bare `boolean`,
`useCollectionDropTarget` and `useWishDropTarget` returning `{ armed, over }`,
`NOT_A_DRAG = "[data-no-drag], input, select, textarea"`, `CollisionPriority.Highest = 4`,
`defaultPreset.plugins = [Accessibility, AutoScroller, Cursor, Feedback, PreventSelection]`, and
`Droppable`'s input accepting `collisionPriority` while `computeCollisions` overrides the
detector's own with it.

**The honest risk.** Task 5 is large enough that a reviewer cannot hold it in one head, and the
thing it is most likely to get wrong is invisible: a target that arms on a payload it should be
blind to. `readCards` and its mutation step exist for exactly that, and Task 5's Step 9 runs the
two payloads it did not touch for the same reason. The second risk is `collisionPriority` — jsdom
gives every box the rect a test wrote, so a test can be made to pass with the priority either way
if the boxes are chosen carelessly; the mutation step says how to choose them, and Task 6 is what
settles it against real geometry.
