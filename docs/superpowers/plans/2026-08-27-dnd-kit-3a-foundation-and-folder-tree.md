# dnd-kit 3a: Foundation, Test Harness, and the Folder Tree — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Get one drag domain — the folder tree, shared by collection, wishlist and decks — onto `@dnd-kit/react`, with a test harness that works for pointer-based dragging, so the remaining six domains have a proven pattern to follow.

**Architecture:** `@dnd-kit/react` is added alongside `@atlaskit/pragmatic-drag-and-drop`; the two coexist on **different elements**, which is safe. `src/test-drag.ts` gains a pointer-driven path beside its existing HTML5 one. `src/lib/folderDrag.ts` keeps every export it has today and changes only its internals — so its seventeen consumers are untouched.

**Tech Stack:** React 19, TypeScript 6.0.x, Vitest, `@dnd-kit/react` (pinned exactly).

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §6.4.

## Why this is three PRs and this is the first

Measured 2026-08-27: **21 production modules**, 13 test files and 6 story files import pragmatic-dnd, across seven drag domains (`folderDrag` 337 lines, `collectionDrag` 342, `dnd` 563, `categoryDrag` 218, `wishDrag` 199, `useSidebarDrops` 187, `deckDrag` 166). That is too large for one review.

- **3a (this plan):** the dependency, the test harness, and the folder tree.
- **3b:** the remaining six domains, following 3a's proven pattern.
- **3c:** remove `@atlaskit/pragmatic-drag-and-drop` and `-auto-scroll`, and the HTML5 half of the harness.

The folder tree goes first because it is shared by three pages, so migrating it exercises the pattern across the widest surface for one unit of work.

## The unknown this plan is shaped around

`@dnd-kit/react` is **provider-and-hooks** shaped. `folderDrag.ts` is **imperative**: `folderDraggable({ element, folder })` registers on a DOM element and returns a cleanup, and `useFolderDropTarget({ ref, … })` takes a ref. Whether dnd-kit can be driven that way — or whether the public API of `folderDrag.ts` has to become hooks — **decides the shape of 3b and 3c**, and I will not guess it.

**Task 1 answers it by building the smallest real thing and writing the answer down.** Every later task, and the whole of 3b, is written against that answer rather than against an assumption.

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned.
- **Pin `@dnd-kit/react` exactly — no caret.** It is 0.5.0, pre-1.0, and its API can break between releases.
- **Only one drop-target registration per element.** A second silently replaces the first. During 3a–3b the two libraries coexist, which is fine *because they are on different elements* — never put both on one.
- **Never assert a new drop works without re-asserting the old one still does.**
- Storybook: after changing anything that alters how UI looks, call `preview-stories` and include every returned URL.

---

### Task 1: Add the dependency and establish the API shape

**Files:**
- Modify: `package.json`
- Create: `src/lib/dnd/spike.test.tsx` — a throwaway that gets deleted in Step 6
- Create: `docs/reference/frontend-design.md` — append a "Drag and drop" section (do not create a new doc)

**Interfaces:**
- Consumes: nothing.
- Produces: a written answer to "can dnd-kit be driven imperatively", which Tasks 3 and all of 3b depend on.

- [ ] **Step 1: Install, pinned**

```bash
npm install --save-exact @dnd-kit/react@0.5.0
grep -n '"@dnd-kit/react"' package.json
```
Expected: `"@dnd-kit/react": "0.5.0"` — **no caret**. If npm wrote one, fix it by hand.

- [ ] **Step 2: Write a throwaway that answers the question**

Create `src/lib/dnd/spike.test.tsx`. This exists to be read once and deleted:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DragDropProvider } from "@dnd-kit/react";
import { useDraggable, useDroppable } from "@dnd-kit/react";

/**
 * Throwaway. The question: what shape does @dnd-kit/react force on a call site, and can a
 * plain DOM element be registered without the component owning a hook?
 */
describe("what shape does dnd-kit force", () => {
  it("renders a draggable and a droppable inside a provider", () => {
    function Item() {
      const { ref } = useDraggable({ id: "a" });
      return <div ref={ref} data-testid="src" />;
    }
    function Zone() {
      const { ref } = useDroppable({ id: "z" });
      return <div ref={ref} data-testid="dst" />;
    }
    const onDragEnd = vi.fn();
    render(
      <DragDropProvider onDragEnd={onDragEnd}>
        <Item />
        <Zone />
      </DragDropProvider>,
    );
    expect(screen.getByTestId("src")).toBeInTheDocument();
    expect(screen.getByTestId("dst")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it and read what the library actually requires**

Run: `npm run test -- src/lib/dnd/spike.test.tsx 2>&1 | tail -30`

Record, from what actually happens rather than from the docs:

1. Does `DragDropProvider` have to wrap the tree, or can a draggable exist without one?
2. Are `useDraggable`/`useDroppable` the only entry points, or is there a non-hook registration (a manager instance, a `register(element)`)?
3. Does `useDraggable` return a `ref` callback that can be handed to an existing element, or does it require the component to own the element?
4. What does a drop handler receive — ids, or arbitrary data attached at registration? `folderDrag.ts` attaches a `FolderDrag` record and reads it back with `readFolderDrag`, so **whether arbitrary data survives the round trip decides whether `folderDragData`/`readFolderDrag` survive at all**.

- [ ] **Step 4: Write the answer down where the next person will find it**

Append a `## Drag and drop` section to `docs/reference/frontend-design.md` recording all four answers, dated, with the version measured (`@dnd-kit/react` 0.5.0). State plainly whichever is true:

- **If imperative registration is possible:** `folderDrag.ts` keeps its exported shape and only its internals change; its seventeen consumers are untouched. 3b follows the same rule.
- **If it is hooks-only:** `folderDraggable` and `useFolderDropTarget` both become hooks, **consumers change**, and 3b is substantially larger than 3a suggests. Say so, and say by how much — count the call sites with `grep -rn 'folderDraggable\|useFolderDropTarget' src`.

> This document is the deliverable of Task 1. The code in Step 2 is not.

- [ ] **Step 5: If the answer makes 3b materially larger, stop and report**

If dnd-kit is hooks-only and the consumer count is above ~20 call sites, **stop here and report before writing code**. That is a different-sized project than the one this plan was scoped as, and Markus asked to be told when a decision's cost changes.

- [ ] **Step 6: Delete the throwaway and commit**

```bash
rm src/lib/dnd/spike.test.tsx
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add package.json package-lock.json docs/reference/frontend-design.md
git commit -m "chore(dnd): add @dnd-kit/react pinned at 0.5.0, and record the API shape it forces

Pinned exactly, no caret: 0.5.0 is pre-1.0 and its API can break between releases.

The reference doc now records what the library actually requires — provider or not, hooks or
imperative, and whether arbitrary drag data survives a round trip — measured by building the
smallest real thing rather than read off the docs. Every later task and the whole of 3b is
written against that answer."
```

---

### Task 2: A pointer-driven path in the test harness

**Files:**
- Modify: `src/test-drag.ts` (add beside the existing HTML5 helpers; do not remove them)
- Test: `src/test-drag.test.ts` — create if absent

**Interfaces:**
- Consumes: the Task 1 answer.
- Produces: `pointerDrag(from: HTMLElement, to: HTMLElement, opts?: { steps?: number }): Promise<void>` exported from `@/test-drag`.

> **Why the existing harness cannot be reused.** `src/test-drag.ts` opens by explaining that a native HTML5 drag is testable *because* `@atlaskit/pragmatic-drag-and-drop` "hit-tests with `event.target` and `Element.closest`, never with `elementFromPoint`". dnd-kit is pointer-based and hit-tests by **coordinate**. jsdom measures every rectangle as zero, so a pointer drag has to be given geometry or nothing will ever be under the pointer.

> ⚠️ **This is the task most likely to produce a vacuous pass.** A harness that dispatches events nothing listens to yields a green test that proves nothing. Step 4 exists solely to prove the harness can fail.

- [ ] **Step 1: Write the failing test**

Create `src/test-drag.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { pointerDrag } from "@/test-drag";

/** jsdom measures everything as 0×0, so a test that needs geometry must supply it. */
function boxed(x: number, y: number, w = 100, h = 40): HTMLElement {
  const el = document.createElement("div");
  el.getBoundingClientRect = () =>
    ({ x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

describe("pointerDrag", () => {
  it("fires a pointerdown on the source and a pointerup at the target's centre", async () => {
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const down = vi.fn();
    const up = vi.fn();
    from.addEventListener("pointerdown", down);
    document.addEventListener("pointerup", up);

    await pointerDrag(from, to);

    expect(down).toHaveBeenCalledTimes(1);
    const evt = up.mock.calls[0][0] as PointerEvent;
    expect(evt.clientX).toBe(50);
    expect(evt.clientY).toBe(220);
  });

  it("moves through intermediate points so a distance threshold is crossed", async () => {
    const from = boxed(0, 0);
    const to = boxed(0, 200);
    const moves: number[] = [];
    document.addEventListener("pointermove", (e) => moves.push((e as PointerEvent).clientY));

    await pointerDrag(from, to, { steps: 5 });

    expect(moves.length).toBeGreaterThanOrEqual(5);
    // Monotonic and ending at the target's centre: a library watching for a threshold or a
    // direction must see a real gesture, not a teleport.
    expect(moves.at(-1)).toBe(220);
    expect([...moves].sort((a, b) => a - b)).toEqual(moves);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -- src/test-drag.test.ts 2>&1 | tail -15`
Expected: FAIL — `pointerDrag is not a function`.

- [ ] **Step 3: Implement**

Append to `src/test-drag.ts`:

```ts
/**
 * A pointer-driven drag, for `@dnd-kit/react`.
 *
 * **Why this exists beside the HTML5 helpers above.** Those work because pragmatic-dnd
 * hit-tests with `event.target` and `Element.closest`. dnd-kit is pointer-based and
 * hit-tests by coordinate — and jsdom measures every rectangle as zero, so a test that
 * needs a pointer to be *over* something has to give both elements a real
 * `getBoundingClientRect`. This helper reads the rects it is given; supplying them is the
 * caller's job, and a test that forgets will see a drag that lands nowhere.
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
      fire("pointermove", { x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t }, document);
      // A frame between moves: dnd-kit schedules its collision work, and a burst of moves
      // in one tick is not the gesture a person makes.
      await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
    fire("pointerup", end, document);
  });
}
```

If `PointerEvent` is undefined under this jsdom, add a constructor shim to `src/test-setup.ts` beside the existing `elementsFromPoint` and `setPointerCapture` shims, in the same `??=` style so a jsdom that grows a real one is preferred.

- [ ] **Step 4: Prove the harness can fail**

Run: `npm run test -- src/test-drag.test.ts 2>&1 | tail -10`
Expected: 2 passed.

Now temporarily change `fire("pointerup", end, document)` to dispatch at `start` instead of `end`. The first test must FAIL on `clientY`. Revert.

Then temporarily change `steps` to always be `1`. The second test must FAIL on `moves.length`. Revert.

**If either survives, the harness is not measuring what it claims** — stop and report rather than building three PRs on it.

- [ ] **Step 5: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/test-drag.ts src/test-drag.test.ts src/test-setup.ts
git commit -m "test(dnd): a pointer-driven drag helper, beside the HTML5 one

The existing helpers work because pragmatic-dnd hit-tests with event.target and closest.
dnd-kit hit-tests by coordinate, and jsdom measures every rect as zero — so this reads the
rects it is given and the caller must supply them. A test that forgets sees a drag landing
nowhere, which is why the helper's own tests assert the coordinates and the step count
rather than merely that it ran."
```

---

### Task 3: Migrate `folderDrag.ts`'s internals

**Files:**
- Modify: `src/lib/folderDrag.ts` — `folderDraggable` (~line 122) and `useFolderDropTarget` (~line 248) only
- Test: `src/lib/folderDrag.test.ts` — extend, do not rewrite

**Interfaces:**
- Consumes: `pointerDrag` (Task 2); the Task 1 answer about registration shape.
- Produces: `folderDraggable` and `useFolderDropTarget` with **the signatures they have today**, if Task 1 found imperative registration possible. If Task 1 found hooks-only, produce the hook forms it recorded — and update this task's steps to match before starting, rather than forcing the old shape.

> **The pure helpers do not change.** `folderDragData`, `readFolderDrag`, `folderEdge`, `FOLDER_EDGES` and `FolderEdge` are library-agnostic — they are geometry and a data record — and their existing tests must keep passing untouched. That is a large part of why this domain was chosen to go first.

- [ ] **Step 1: Record the baseline**

```bash
npm run test -- src/lib/folderDrag.test.ts src/features/collection src/features/wishlist src/features/decks 2>&1 | tail -8
```
Write down every count. These are what "the old drop still works" means.

- [ ] **Step 2: Write the failing test for the new drop**

Append to `src/lib/folderDrag.test.ts`. Give both elements real rects, per Task 2's contract:

```ts
it("drops a folder before its sibling when released on the sibling's top half", async () => {
  // Build whatever minimal component this file's existing tests use to mount a drop target;
  // reuse that helper rather than adding a second one.
  const { source, target, onDrop } = mountFolderPair({ axis: "vertical" });
  await pointerDrag(source, target);
  expect(onDrop).toHaveBeenCalledTimes(1);
  const [drag, edge] = onDrop.mock.calls[0];
  expect(drag.id).toBe(source.dataset.folderId);
  expect(edge).toBe("before");
});
```

If `mountFolderPair` does not exist, write it in the test file using the same shape the existing folder-drag tests already use to render a target, and give both elements a stubbed `getBoundingClientRect` — the source at y 0–40 and the target at y 100–140, so the release point lands in the target's top half and `folderEdge` returns `"before"`.

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -- src/lib/folderDrag.test.ts 2>&1 | tail -15`
Expected: FAIL — the drop does not fire, because the target is still registered with pragmatic-dnd and nothing is listening for pointer events.

- [ ] **Step 4: Migrate the two functions**

Replace the bodies of `folderDraggable` and `useFolderDropTarget` with dnd-kit registrations, following exactly the shape Task 1 recorded. Keep every doc comment on both functions — they explain the `mousedown` guard, why `folder` is a callback read at drag start, and why `edge` deliberately does not stand down in the monitor's `onDrop`. **Those reasons survive the library change; re-read each and correct only the sentences that name pragmatic-dnd specifically.**

Preserve these behaviours exactly, each of which has a comment in the file today saying why:

- the capture-phase `mousedown` guard, so a press on a `⋯` menu or a rename field does not start a drag
- `folder` read at drag start, not at registration, so a renamed or moved folder carries what it is now
- `armed` set on drag start and cleared on drop **and on cancel** — dnd-kit must end a cancelled drag the same way, and if it does not, this needs an explicit Escape path and a test
- `edge` cleared by the target's own leave, not by the monitor

- [ ] **Step 5: Run the new test and the whole baseline**

```bash
npm run test -- src/lib/folderDrag.test.ts src/features/collection src/features/wishlist src/features/decks 2>&1 | tail -10
```
Expected: the new test passes **and every count from Step 1 is unchanged**.

- [ ] **Step 6: Prove the old drop still works, explicitly**

The migrated domain is not the risk; the untouched ones are. Run a drag that this PR did not migrate and confirm it is unaffected:

```bash
npm run test -- src/features/decks/dnd.test.ts src/features/collection/collectionDrag.test.ts 2>&1 | tail -8
```
Expected: unchanged and green. **A second registration on one element silently replaces the first** — if a card is both a folder target and a card target, this is where that shows up.

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify.log 2>&1; grep -E "Test Files|Tests " /tmp/verify.log
git add src/lib/folderDrag.ts src/lib/folderDrag.test.ts
git commit -m "refactor(dnd): the folder tree drags with @dnd-kit/react

Internals only — folderDragData, readFolderDrag, folderEdge and FOLDER_EDGES are geometry
and a data record, are library-agnostic, and keep their tests untouched. That is most of why
this domain went first.

Every behaviour with a comment explaining it is preserved: the capture-phase mousedown guard
so a press on a menu or a rename field does not start a drag; folder read at drag start so a
renamed folder carries what it is now; armed standing down on cancel as well as drop.

The collection and deck drags are asserted unchanged in the same run — a second registration
on one element silently replaces the first, so a working new drop is never evidence the old
one survived."
```

---

### Task 4: Verify in the real window

**Files:** none — this task produces a measurement, not a diff.

**Interfaces:**
- Consumes: Task 3.
- Produces: a live-verification note appended to `docs/reference/decks-live-findings.md`.

> **This is the first drag in this app's history that a live pass can actually drive.** HTML5 DnD cannot be started from a synthetic event — Chrome refuses — so every pragmatic-dnd drop has been unverifiable in the real window, and the live passes could only confirm *registration*. dnd-kit is pointer-based, and pointer events dispatch fine over CDP. Do not skip this task: it is the payoff.

- [ ] **Step 1: Take the app lock and start the app**

Follow the `running-the-app` skill. **Only one app runs across every worktree and the collision is silent.**

- [ ] **Step 2: Drive a real folder drag over CDP**

Use `scripts/cdp.mjs` per [the contract](../../reference/live-ui-verification.md). Dispatch `pointerdown` on a folder card, several `pointermove`s toward a sibling, and a `pointerup`.

Two traps that have each cost a session here:
- **`cdp.mjs click` needs a `hover --rest 200` first** — a cold pointer makes the next action a no-op that still prints success.
- **Clicking and reading in one `eval` answers about the frame before React re-rendered.** Split the drop and the assertion into two separate `eval` calls.

- [ ] **Step 3: Assert the write reached the backend**

Re-read the folder order from the page after the drop, in a **second** eval. Then confirm it persisted by reloading the window and reading it again — a reorder that only moved React state looks identical to one that reached SQLite until you reload.

- [ ] **Step 4: Record it**

Append to `docs/reference/decks-live-findings.md`: the date, the build, what was driven, what was asserted, and — plainly — that this is the first drag verified end to end in the real window rather than only at registration. Note any behaviour that differs from the test suite.

- [ ] **Step 5: Release the app lock and commit**

```bash
git add docs/reference/decks-live-findings.md
git commit -m "docs(decks): the folder drag verified in the real window, driven end to end

The first drag in this app verified as a GESTURE rather than as a registration. HTML5 DnD
cannot be started from a synthetic event, so every pragmatic-dnd drop has been undrivable
over CDP and the live passes could only confirm that the right elements were draggable.
dnd-kit is pointer-based and dispatches fine, so the drop and its persistence are both
asserted here."
```

---

## Self-Review

**Spec coverage.** Implements spec §6.4 for one domain, plus the harness every other domain needs. 3b and 3c are named and scoped but deliberately unplanned — 3b's shape depends on Task 1's answer, and writing it now would bake in the guess this plan exists to avoid.

**Placeholders.** Task 3's Step 2 says "reuse that helper rather than adding a second one" and then specifies exactly what to build if it is absent, including the coordinates. Task 3's Step 4 is a transformation whose *invariants* are enumerated rather than its lines — because the target API is Task 1's finding, and pretending to know it here would be the exact failure this plan is shaped to prevent.

**Type consistency.** `pointerDrag(from, to, opts?)` is defined in Task 2 and used with that signature in Tasks 3 and 4. `folderDraggable` and `useFolderDropTarget` keep today's signatures, conditional on Task 1 — and Task 1 Step 5 escalates rather than improvises if they cannot.

**The honest risk.** Task 1 may find that dnd-kit forces hooks, in which case 3b is materially larger than "the remaining six domains, following the pattern" implies. Step 5 of Task 1 is the stop-and-report gate for exactly that, and it is there because the decision to replace the library was taken when the field looked healthier than it measured.
