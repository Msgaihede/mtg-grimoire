# dnd-kit 3c: Remove pragmatic-dnd, and Decide What a Drag Says — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take `@atlaskit/pragmatic-drag-and-drop` and `-auto-scroll` out of the tree along with
the half of the test harness that existed for them — and then settle the question 3a deferred:
what a drag in this app is to a reader who is not holding a mouse, now that dnd-kit's
`Accessibility` plugin has been refused and its `KeyboardSensor` has been kept.

**Architecture:** After 3b every registration in the app is a `@dnd-kit/dom` `Draggable` or
`Droppable` on the one module-level `DragDropManager` in `src/lib/dndManager.ts`. Nothing imports
`@atlaskit/*`. So the first half of this plan is a removal that can be proved by `grep`, and the
second half is the only part with a design in it.

**Tech Stack:** React 19, TypeScript 6.0.x, Vitest, Storybook 10, `@dnd-kit/dom` 0.5.0.

**Spec:** [`docs/superpowers/specs/2026-08-27-cross-platform-design.md`](../specs/2026-08-27-cross-platform-design.md) §6.4.

**Predecessors:** [3a](2026-08-27-dnd-kit-3a-foundation-and-folder-tree.md) and
[3b](2026-08-28-dnd-kit-3b-remaining-domains.md), both merged. **This plan does not begin until
3b is on `main`** — Task 1's first act is a `grep` that must come back empty, and it cannot until
3b's Task 5 has landed.

---

## What is actually left, and what is actually undecided

Read out of the post-3a tree on 2026-08-28; the numbers 3b changes are named as such.

**The removal is small and mechanical.** Two lines in `package.json`
(`"@atlaskit/pragmatic-drag-and-drop": "^2.0.2"` and
`"@atlaskit/pragmatic-drag-and-drop-auto-scroll": "^3.0.0"`), and the HTML5 half of
`src/test-drag.ts` — `TestDataTransfer`, `send`, `fireDragEvent`, the `Drag` interface,
`startDrag`, `dragOnto`, and half of the module's `afterEach`, which is roughly the first half of
the file. Eleven files mention pragmatic-dnd **in prose only** and every one of those mentions is
history worth keeping; the sweep this plan adds must be written so that prose does not fail it.

**`@dnd-kit/react` is a third line that nothing imports.** `grep -rn "@dnd-kit/react" src/`
returns nothing: 3a wrote `dndManager.ts` against `@dnd-kit/dom`, and its own doc comment explains
at length why the hooks are not used. 3b declared `@dnd-kit/dom` and `@dnd-kit/abstract` directly.
So the wrapper is a dependency this app pays for and never calls, and Task 2 decides it.

### The accessibility question, stated as it actually is

3a removed the `Accessibility` plugin. Markus's answer to whether that was right was **"revisit in
3c"**, so this plan owes a decision rather than an inheritance. Four things are true, and each was
read out of `node_modules/@dnd-kit/dom/index.js` rather than out of the documentation:

1. **The plugin's DOM mutations are not configurable, and 3a's objection to them stands.** Its
   `registerEffect` walks `manager.registry.draggables` and, for each `draggable.handle ??
   draggable.element`, adds `tabindex="0"` unless the element is an `input`/`select`/`textarea`/`a`/`button`
   or already has one; `role="button"` unless the element already has a `role` or *is* a `<button>`;
   `aria-roledescription="draggable"`; `aria-describedby` pointing at a hidden instructions `<div>`
   it appends to `<body>`; and `aria-pressed`, `aria-grabbed` and `aria-disabled` kept in step with
   the drag. There is **no option to turn any of that off**. `role="button"` on the collection's
   folder `<li>` takes the `listitem` role away, which is how a screen reader says how many drawers
   there are; `tabindex="0"` adds a tab stop per card, which `src/CLAUDE.md` names as the thing a
   row must never do (`tabIndex={-1}` — never `0`); and `aria-grabbed` has been deprecated since
   ARIA 1.1. **The app can pre-empt the first two by stamping its own `tabindex` and `role`** — the
   plugin skips an element that already has them — but it cannot pre-empt the other four.
2. **The half of the plugin that is worth having *is* configurable, and its defaults are useless
   here.** `announcements` and `screenReaderInstructions` are both plugin options
   (`Announcements` = `{ dragstart, dragend, dragmove?, dragover? }`, each
   `(event, manager) => string | undefined`). The defaults announce `Picked up draggable item
   ${source.id}` — and `source.id` in this app is `dndId()`'s counter, `folder-source-3`, which
   `dndManager.ts`'s own comment describes as "a registry key and nothing else". So even keeping
   the plugin would mean writing every announcement by hand. **What the plugin would supply that
   the app does not have is the live region and the hidden instructions element, which are about
   fifteen lines.**
3. **`KeyboardSensor` was kept, and 3a's sentence about it — "dragging a folder from the keyboard
   is unaffected" — is not true of this app's markup.** `KeyboardSensor.bind` attaches its
   `keydown` to `source.handle ?? source.element`, and
   `KeyboardSensor.defaults.preventActivation` is `event.target !== (source.handle ?? source.element)`.
   So a keyboard drag requires **the draggable element itself to be the focused element**. The
   folder tree's source is a `<div ref={folderRef}>` with no `tabindex`; the collection's and the
   wishlist's is an `<li ref={ref}>` with none. Neither can be focused, so neither can be dragged
   from a keyboard. Nothing regressed — pragmatic-dnd is HTML5 drag-and-drop and has no keyboard
   path at all — but the sentence promises something that does not happen, and this plan owes the
   correction.
4. **After 3b there is exactly one draggable in the app whose activator is focusable, and it
   already has a keyboard behaviour of its own.** `useCategoryDragSource` declares the grip
   `<button>` as the `handle`, and that button's `onKeyDown` is the whole keyboard reorder —
   `ArrowLeft`/`ArrowRight` in `StackView.tsx`'s `CategoryGrip`, `ArrowUp`/`ArrowDown` in
   `CategoriesDialog.tsx` — each writing a real move, each labelled `Move <name>, <n> of <total>`
   so the reader hears where it landed. `KeyboardSensor`'s codes are `start: ["Space", "Enter"]`,
   `cancel: ["Escape"]`, `end: ["Space", "Enter", "Tab"]` and the four arrows. 3b Task 2 Step 8
   pins what actually happens when those two meet. **This plan is where it is fixed.**

**So the question is not "put the plugin back or not".** It is three questions, and Tasks 3–5
answer one each:

- Which sensors should the manager have, given that a keyboard drag is currently unreachable
  everywhere except one control that already does the job better without it? (Task 4)
- What should a screen reader hear during a drag, given that the plugin's own announcements would
  read out registry ids? (Task 5)
- What is true today, so that either answer is measured against something rather than assumed?
  (Task 3)

---

## Global Constraints

- `npm run verify` before every commit. It does **not** run `cargo fmt` or `clippy`; this plan
  touches no Rust.
- **`src/stories.test.tsx` collects the whole story tree.** A targeted `npm run test -- <path>`
  run never touches a story play. Every task below runs it explicitly, and Task 1 in particular:
  deleting exported helpers from `src/test-drag.ts` is exactly the kind of change a targeted run
  reports as green.
- **Never assert a new behaviour works without re-asserting the shipped ones still do.** Tasks 4
  and 5 both add a listener to the one manager every drag in the app goes through.
- **A source sweep must not fail on prose.** Eleven files mention `@atlaskit/pragmatic-drag-and-drop`
  in a doc comment as history — `src/lib/focus.ts`, `src/features/decks/DropIndicator.tsx`,
  `src/features/decks/formFields.ts`, `src/lib/dndManager.ts`, `src/lib/folderDrag.ts`,
  `src/features/decks/dnd.test.ts` and more. Those mentions are the record of why decisions were
  taken and are not to be deleted. Any sweep this plan adds matches the **import statement**, not
  the name. See `src/lib/tokens.test.ts`, where a class named in a comment failing the token sweep
  is a mistake this repo has already made once.
- **Never install `@types/node`.** TypeScript stays on 6.0.x. `xlsx` is banned.
- **Do not run two `npm run verify`s at once.**

---

### Task 1: Delete the HTML5 half of the test harness

**Files:**
- Modify: `src/test-drag.ts` (392 lines after 3a) — remove the pragmatic half, keep the pointer half
- Modify: `src/test-drag.test.ts` — remove anything asserting the removed helpers
- Modify: the four story files, **only if 3b left a copy behind**: `src/components/AppShell.stories.tsx`,
  `src/features/decks/QuickZones.stories.tsx`, `src/features/collection/CollectionFolderCard.stories.tsx`,
  `src/features/wishlist/WishFolderCard.stories.tsx`

**Interfaces:**
- Consumes: 3b, which removed the last call site.
- Produces: `src/test-drag.ts` exporting `startPointerDrag`, `pointerDrag`, `boxed` and
  `PointerHeld`, and nothing else.

> **The deletion is safe only because 3b's Step 8 said so, and this task's first act is to say it
> again.** A helper with no callers deletes cleanly; a helper with one caller in a story file
> deletes green under every targeted run and red only under `src/stories.test.tsx`.

- [ ] **Step 1: Prove there are no callers**

```bash
grep -rn '\bstartDrag(\|\bdragOnto(\|\bfireDragEvent(' src/ .storybook/ | grep -v 'src/test-drag.ts'
grep -rn 'StoryDataTransfer\|TestDataTransfer' src/ .storybook/ | grep -v 'src/test-drag.ts'
grep -rn 'from "@atlaskit' src/ .storybook/
```

All three must come back **empty**. If any does not, 3b is incomplete: stop, report which file,
and finish that migration before deleting anything. Do not delete a helper and then fix its
callers — that inverts which run is the evidence.

- [ ] **Step 2: Record the baseline**

```bash
npm run test:run > /tmp/baseline-3c-1.log 2>&1; grep -E "Test Files|Tests " /tmp/baseline-3c-1.log
```
The whole suite, because `src/test-drag.ts` is imported by every file that drags anything and
its module-scope `afterEach` runs in all of them. Do not read an exit code through a pipe.

- [ ] **Step 3: Delete the pragmatic half of `src/test-drag.ts`**

Remove, in this order (the module reads top to bottom and the removals are contiguous):

- the module's opening doc comment about **why a native HTML5 drag is testable at all** —
  pragmatic-dnd hit-testing with `event.target` and `Element.closest`, jsdom having no `DragEvent`
  and no `DataTransfer`. **Do not simply delete it.** Move its conclusion into the pointer half's
  comment, where it is now the *contrast*: dnd-kit hit-tests by coordinate against measured
  rectangles, which is why every element in a pointer test needs a `getBoundingClientRect` and why
  the HTML5 helpers needed none. That contrast is the single most useful sentence in the file for
  the next person and it dies with the code unless it is moved.
- `class TestDataTransfer`
- `function send`
- `export function fireDragEvent`
- `export interface Drag`
- `export async function startDrag`
- `export async function dragOnto`
- from the module-scope `afterEach`, the line
  `fireEvent(window, new MouseEvent("dragend", { bubbles: true }));` and the comment above it.
  **Keep the dnd-kit half** — the `if (!dndManager.dragOperation.status.idle)` Escape — and keep
  the `afterEach` itself. Its comment still needs the paragraph about one global "a drag is
  active" flag turning one broken assertion into five; only the library it names changes.
- the `fireEvent` import, if nothing below still uses it. `frame()` uses `act`, which stays.

Keep `frame()` — the pointer helpers call it. Keep `startPointerDrag`, `pointerDrag`, `PointerHeld`,
`settle`, `centre`, `fire` and `NOWHERE`, all unchanged. Keep the `boxed` helper 3b moved here.

- [ ] **Step 4: Run the suite that would catch a missed caller**

```bash
npm run test -- src/test-drag.test.ts 2>&1 | tail -10
npm run test -- src/stories.test.tsx 2>&1 | tail -10
npx tsc --noEmit 2>&1 | tail -20
```
`tsc` is the one that finds a caller `grep` missed — a re-export, an aliased import, a story
importing through a barrel. Expected: no errors, and both suites at Step 2's counts.

- [ ] **Step 5: Prove the deletion could have failed**

A removal has no natural red, so make one. Temporarily delete `startPointerDrag` as well and run
`npx tsc --noEmit`. It must report errors in **at least** `src/lib/folderDrag.test.ts`,
`src/lib/dndManager.test.ts` and `src/test-drag.test.ts`. Restore it.

**This is the step that proves `tsc --noEmit` is actually reading these files.** Without it, "no
errors" after a deletion is indistinguishable from a type-check that never looked.

- [ ] **Step 6: The whole suite, against Step 2**

```bash
npm run test:run > /tmp/after-3c-1.log 2>&1; grep -E "Test Files|Tests " /tmp/after-3c-1.log
```
`Tests` may be **lower** than Step 2's — `src/test-drag.test.ts` had tests for helpers that no
longer exist, and deleting those is correct. Say by how many and which, in the commit message.
No *other* file's count may move.

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify-3c-1.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-1.log
git add src/test-drag.ts src/test-drag.test.ts
git commit -m "test(dnd): the HTML5 half of the drag harness goes with the library

Nothing has called startDrag, dragOnto or fireDragEvent since 3b, and the four story files that
each carried a copy of the same DataTransfer shim now press a pointer instead.

The one thing kept out of the deleted comment is its contrast, moved into the half that remains:
a native HTML5 drag was testable because pragmatic-dnd hit-tested with event.target and closest,
which is exactly why those helpers needed no geometry and why every element in a pointer test
needs a getBoundingClientRect. That sentence is the most useful one in the file for whoever
writes the next drag test, and it dies with the code unless it moves.

The afterEach stays and so does its reasoning: one global 'a drag is active' flag still turns one
broken assertion into five in tests that never mention dragging. Only the flag's owner changed —
dnd-kit's operation, ended with an Escape at the body rather than a dragend at the window."
```

---

### Task 2: Uninstall both packages, and settle `@dnd-kit/react`

**Files:**
- Modify: `package.json`, `package-lock.json`
- Modify: `src/lib/dndManager.test.ts` — add the sweep that keeps them out
- Modify: `docs/reference/frontend-design.md` — the `## Drag and drop` section's opening paragraph
  still says the two libraries coexist

**Interfaces:**
- Consumes: Task 1.
- Produces: a tree with no `@atlaskit` dependency and a test that goes red if one comes back.

- [ ] **Step 1: Uninstall**

```bash
npm uninstall @atlaskit/pragmatic-drag-and-drop @atlaskit/pragmatic-drag-and-drop-auto-scroll
grep -n 'atlaskit' package.json package-lock.json | head
```
Expected: no matches in either. `npm uninstall` prunes the transitive tree too — `bind-event-listener`
and `raf-schd` are pragmatic-dnd's dependencies and should go with it. Note in the commit how many
packages `npm` reported removing; it is the only number this task produces.

- [ ] **Step 2: Decide `@dnd-kit/react`, with the evidence**

```bash
grep -rn '@dnd-kit/react' src/ .storybook/ scripts/
```
Expected: **nothing.** 3a added the package and then wrote `dndManager.ts` against `@dnd-kit/dom`
directly, for reasons its own doc comment sets out at length; 3b declared `@dnd-kit/dom` and
`@dnd-kit/abstract` so that the imports match the manifest. So the wrapper is unreferenced.

**Remove it**, unless the grep finds something:

```bash
npm uninstall @dnd-kit/react
grep -n '"@dnd-kit/' package.json
```
Expected: `"@dnd-kit/abstract": "0.5.0"` and `"@dnd-kit/dom": "0.5.0"`, both exact, and nothing
else. Then check the lockfile did not move the two that remain:

```bash
git diff package-lock.json | grep -E '^\+.*"version"' | head
```
Expected: no version line added for `@dnd-kit/dom` or `@dnd-kit/abstract`. **A bump means the
uninstall re-resolved the tree** — `@dnd-kit/react` depended on `^0.5.0`, so dropping it removes a
constraint — and the pin has to be checked by hand before going on.

> **The peer dependency is the reason to look twice.** `@dnd-kit/react` declares
> `react: ^18.0.0 || ^19.0.0` as a peer; `@dnd-kit/dom` declares none. Removing it removes the
> only thing in the dnd-kit tree that says which React this library was built against. That is a
> real loss of a signal, and it is worth one line in the reference doc rather than nothing: the
> React version this drag stack has been proved against is recorded by this repo, not by the
> dependency graph, from here on.

- [ ] **Step 3: Write the sweep that keeps them out**

Append to `src/lib/dndManager.test.ts`, which is already the fence around this library's
integration:

```ts
/**
 * Every source file in the app, as text. `?raw` through Vite rather than `node:fs` — this project
 * has no `@types/node` on purpose, and `src/lib/tokens.test.ts` reaches for the same trick.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/**
 * **The banned thing is the import, not the name.** Eleven files in this app mention
 * `@atlaskit/pragmatic-drag-and-drop` in a doc comment, and every one of those mentions is the
 * record of why something is the way it is — why `DropIndicator` draws its own line rather than
 * taking the hitbox package, why `folderDrag.ts`'s edge arithmetic is hand-rolled, why the folder
 * cards nest two boxes. A sweep that matched the bare name would delete this project's memory of
 * its own reasons to stay green. `src/lib/tokens.test.ts` learned that once already, when a class
 * named in prose failed the token sweep.
 */
const PRAGMATIC_IMPORT = /(?:from|import)\s*\(?\s*["']@atlaskit\//;

describe("the drag library is the only drag library", () => {
  it("imports nothing from @atlaskit anywhere in src", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([, source]) => PRAGMATIC_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders, "files importing the removed drag library").toEqual([]);
  });

  /** The half a source sweep cannot see: a dependency can be back in the manifest with nothing
   *  importing it yet, which is how it comes back — one `npm install` that looked harmless.
   *  `manifest` is a static `import manifest from "../../package.json?raw";` at the top of the
   *  file, not a dynamic one — `src/lib/tokens.test.ts` reaches two levels up to
   *  `.storybook/preview.tsx?raw` the same way, and the static form is what Vite's ambient
   *  `*?raw` declaration types. */
  it("declares no @atlaskit dependency", () => {
    expect(manifest).not.toMatch(/"@atlaskit\//);
  });

  /**
   * The sweep proving it can see anything at all. Without this, a glob that silently matched no
   * files — a moved test, a changed pattern — would pass both tests above forever.
   */
  it("is reading real source", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
    expect(PRAGMATIC_IMPORT.test('import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";')).toBe(true);
    expect(PRAGMATIC_IMPORT.test(' * `@atlaskit/pragmatic-drag-and-drop` keeps one drop target per element.')).toBe(false);
  });
});
```

- [ ] **Step 4: Run, then mutate the sweep**

```bash
npm run test -- src/lib/dndManager.test.ts 2>&1 | tail -10
```
Expected: green, three tests more than before.

Then, one at a time, reverting each:

1. Add `import { draggable } from "@atlaskit/pragmatic-drag-and-drop/element/adapter";` to the top
   of `src/lib/folderDrag.ts` (with a `// @ts-expect-error` if `tsc` complains, since the package
   is gone). **"imports nothing from @atlaskit anywhere in src" must fail, and must name that
   file.** If it fails without naming it, the reporter is not printing what the test collected and
   the assertion needs `.toEqual([])` on the *paths* rather than on a boolean.
2. Change the glob to `/src/**/*.nothing`. **"is reading real source" must fail** on the count.
3. Put `"@atlaskit/pragmatic-drag-and-drop": "^2.0.2"` back in `package.json`'s dependencies by
   hand (without installing). **"declares no @atlaskit dependency" must fail.**

**If any survives, stop and report.**

- [ ] **Step 5: Correct the reference doc**

`docs/reference/frontend-design.md`'s `## Drag and drop: what @dnd-kit/react 0.5.0 actually
requires` opens by saying the dependency "landed alongside `@atlaskit/pragmatic-drag-and-drop`;
the two coexist on **different elements**, which is safe, and putting both on one element is not".
That is now history, and two of its sentences are actively wrong for the current tree:

- the two libraries no longer coexist;
- **"a second registration silently replaces the first" is pragmatic-dnd's rule and not
  dnd-kit's.** dnd-kit keys its registry by entity id, so two `Droppable`s on one element both
  register and compete, and what separates them is `accepts()` — `computeCollisions` skips any
  droppable that refuses the source before it measures. Two folder cards and every deck pile in
  the app depend on that.

Rewrite the opening as a dated record of what was true then, and add the current rule under it.
Retitle the section — it names `@dnd-kit/react`, a package this task removes, and what it actually
documents is `@dnd-kit/dom`.

- [ ] **Step 6: Full suite and story plays**

```bash
npm run test -- src/stories.test.tsx 2>&1 | tail -8
npm run verify > /tmp/verify-3c-2.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-2.log
```
Expected: green. `npm run verify` builds, and a build is the only thing that would notice a
lockfile the uninstall left inconsistent.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/lib/dndManager.test.ts docs/reference/frontend-design.md
git commit -m "chore(dnd): remove pragmatic-drag-and-drop, its auto-scroller, and the unused react wrapper

Three packages, and the third is the surprise: @dnd-kit/react was added by 3a and never imported
once. That plan wrote its manager against @dnd-kit/dom directly and said why at length, and 3b
declared the two packages the code actually imports. So the wrapper has been paid for and never
called.

What that costs is one signal worth naming: @dnd-kit/react is the only package in this tree that
declares a React peer dependency, and @dnd-kit/dom declares none. Which React this drag stack has
been proved against is now this repo's to record.

The sweep that keeps the old library out matches an import statement rather than a name, on
purpose. Eleven files mention pragmatic-dnd in prose — why DropIndicator draws its own line, why
the folder edge arithmetic is hand-rolled, why two folder cards nest two boxes — and a sweep that
matched the name would make this project's memory of its own reasons a thing that fails the build.

frontend-design.md's drag section opened by saying the two libraries coexist and that a second
registration on one element silently replaces the first. Neither is true now: dnd-kit keys its
registry by entity id, two droppables on one element both register, and accepts() is what keeps
them apart."
```

---

### Task 3: Measure what a drag is to a keyboard and a screen reader today

**Files:**
- Create: `src/lib/dndAccessibility.test.ts` — the inventory, as assertions rather than as prose
- Modify: `docs/reference/frontend-design.md` — a subsection recording the measurement

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: the facts Tasks 4 and 5 are decided on. **No behaviour changes in this task.**

> **This task exists because "revisit the Accessibility plugin" is not a decision that can be
> taken from the plugin's source.** What matters is what this app's markup does with it, and that
> is a fact about eight draggables in five features. 3a measured one of them, on one page, and
> generalised. Two of the four claims in `dndManager.ts`'s comment about the plugin are checkable
> in jsdom and one of them — "`KeyboardSensor` is a sensor and stays: dragging a folder from the
> keyboard is unaffected" — is very likely false.

- [ ] **Step 1: List every draggable and its activator**

```bash
grep -rn 'dndDraggable(\|folderDraggable(\|cardDraggable(\|composedDraggable(\|deckDraggable(' src/ --include=*.ts --include=*.tsx | grep -v '\.test\.' | grep -v '\.stories\.'
```

For each, find the **element** the registration lands on and write down three things: its tag, its
`tabIndex` (absent, `-1`, or `0`), and whether a `handle` is declared. The four anchors already
measured on 2026-08-28, for comparison — **complete the list, do not trust it as complete**:

| Source | Activator | Tab-reachable? |
| --- | --- | --- |
| `useFolderDragSource` in `FolderTree.tsx` | `<div ref={folderRef}>` | no `tabindex` — not focusable at all |
| `useFolderDragSource` in `CollectionFolderCard.tsx` / `WishFolderCard.tsx` | `<li ref={ref}>` | no `tabindex` — not focusable at all |
| `useDeckCardDrag` in `GridView.tsx` | `<li>` carrying `deckCardMenuProps`, i.e. `tabIndex={-1}` | focusable programmatically, not by Tab |
| `useCategoryDragSource` in `StackView.tsx` / `CategoriesDialog.tsx` | heading `<div>`, **handle = the grip `<button>`** | **yes** — a real button in the tab order |

- [ ] **Step 2: Write the inventory as a test**

Create `src/lib/dndAccessibility.test.ts`. It renders each surface through the same helpers its own
feature's tests use and asserts what is there — **not what ought to be**. A test that fails here
in a month is a signal that something changed, which is the whole point.

```ts
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { dndManager } from "@/lib/dndManager";

/**
 * **What a drag in this app is to a reader who is not holding a mouse — pinned as it is, not as
 * it should be.**
 *
 * 3a removed dnd-kit's `Accessibility` plugin because its DOM mutations take the `listitem` role
 * off a folder card and add a tab stop per row, and kept `KeyboardSensor` on the stated grounds
 * that "dragging a folder from the keyboard is unaffected". This file exists because that second
 * half was never measured, and because whatever 3c decides has to be decided against something.
 *
 * Every assertion here is a **measurement**. If one starts failing, read it as news rather than as
 * a defect: it means the markup under a drag changed, and the decision recorded in
 * `docs/reference/frontend-design.md` may no longer follow from the facts it was taken on.
 */
describe("what a drag is to a keyboard", () => {
  /** The plugin's own rule, restated as a test so the reason 3a refused it cannot go stale
   *  silently: it stamps `role="button"` on any activator that is not a `<button>` and carries no
   *  role of its own, which is a folder card's `<li>`. */
  it("keeps every folder card a listitem", () => {
    // Render the collection's folder wall through `CollectionFolderCard`'s own test helper.
    // Assert `getAllByRole("listitem")` finds every card and `queryAllByRole("button", …)` does
    // not find the `<li>` itself — the button inside it is a different element.
  });

  /** `src/CLAUDE.md`: `tabIndex={-1}` — never `0`, which would add a tab stop per card. */
  it("adds no tab stop to any draggable", () => {
    // For each surface in the Step 1 table, render it and assert no element carrying a drag
    // registration has `tabindex="0"`.
  });

  /**
   * **The claim this file was written for.** `KeyboardSensor.bind` listens on
   * `source.handle ?? source.element` and its default `preventActivation` is
   * `event.target !== (source.handle ?? source.element)` — so a keyboard drag needs the draggable
   * element itself to be focused. Assert, per surface, whether that is reachable: press Space on
   * the element a reader can actually focus and read `dndManager.dragOperation.status`.
   */
  it("says which draggables a keyboard can pick up", () => {
    // One assertion per row of the Step 1 table. Expect the folder tree, the folder cards and the
    // deck card to answer `idle` and the category grip to answer otherwise — and if any of those
    // is wrong, the table is wrong and Step 4 is where that is written down rather than here.
  });

  /**
   * The grip is the one activator a keyboard reaches, and it already has a keyboard reorder of its
   * own: ArrowLeft/ArrowRight in `StackView`'s `CategoryGrip`, ArrowUp/ArrowDown in
   * `CategoriesDialog`. This asserts the shipped behaviour survives whatever the sensor does.
   */
  it("still reorders a pile with the arrow keys on its grip", async () => {
    // Focus the grip the way a reader does — Tab to it, or click it — never `element.focus()`,
    // which tests a caret a reader cannot produce. Press ArrowRight with `user.keyboard`. Assert
    // the move was written exactly once.
  });
});
```

> **Each `it` above is a description and a comment, deliberately, because the body depends on how
> each feature's existing tests mount it and inventing a second way to render `CollectionFolderCard`
> would be a worse test than reusing the one that exists.** Read
> `src/features/collection/CollectionFolderCard.test.tsx`,
> `src/features/decks/views/views.test.tsx` and `src/features/decks/FolderTree.test.tsx` and use
> their helpers. **What may not be changed is the assertion each one makes** — those are the
> measurement, and a task that softens one has removed the thing this plan is decided on.

- [ ] **Step 3: Run, and expect at least one surprise**

```bash
npm run test -- src/lib/dndAccessibility.test.ts 2>&1 | tail -20
```

**Do not make a failing assertion pass by changing it.** Every expectation in Step 2 is written
against the Step 1 table; a failure means the table is wrong, and the fix is to correct the table
in Step 4 and re-run. That is the difference between measuring and confirming.

- [ ] **Step 4: Drive the same four questions in the real window**

jsdom answers "is this element focusable" from the DOM; a browser answers it from the DOM *and*
the layout, and a screen reader answers a different question again. Take the app lock, start the
app (`running-the-app` skill — **only one app runs across every worktree and the collision is
silent**), and over `scripts/cdp.mjs`:

1. Tab through the collection's folder wall and record every stop, in order.
2. Tab to a category grip, press ArrowRight, and confirm the pile moves and the grip keeps the
   caret. Then press Space and record `document.activeElement` and whether anything moved.
3. Read `document.body.innerHTML` for a `dnd-kit-description` or `dnd-kit-announcement` element —
   there must be none, because the plugin that appends them is filtered out. This is the assertion
   that 3a's filter is actually taking effect in a built tree rather than only in the plugin list.
4. Pick a folder up with the pointer and read the whole accessibility-relevant attribute set off
   the `<li>` and the `<div>` during the drag: `role`, `tabindex`, `aria-*`. Compare against the
   `role="button" tabindex="0" aria-roledescription="draggable" aria-grabbed="false"` 3a recorded
   *with* the plugin.

Two traps: **`cdp.mjs click` needs a `hover --rest 200` first**, and **clicking and reading in one
`eval` answers about the frame before React re-rendered.**

- [ ] **Step 5: Write the measurement down**

Add a subsection under `docs/reference/frontend-design.md`'s drag section: **"What a drag is to a
keyboard, measured"** — the completed Step 1 table, the four live answers, the date and the build
(debug or release; the same measurement can differ by ~8×). State plainly whether
`dndManager.ts`'s sentence "dragging a folder from the keyboard is unaffected" is true, and if it
is not, **do not fix the comment here** — Task 4 is where the behaviour and the comment change
together, and a comment corrected ahead of the code it describes is a comment that will be wrong
again in one commit.

- [ ] **Step 6: Release the lock and commit**

```bash
npm run verify > /tmp/verify-3c-3.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-3.log
git add src/lib/dndAccessibility.test.ts docs/reference/frontend-design.md
git commit -m "test(dnd): what a drag is to a keyboard, measured rather than assumed

3a removed the Accessibility plugin on a measurement — role=button takes the listitem role off a
folder card, tabindex=0 adds a tab stop per row — and kept KeyboardSensor on a sentence that was
never checked. This file checks it, per surface, and pins the answer.

The mechanism is not obvious from the outside: KeyboardSensor binds its keydown to
source.handle ?? source.element and refuses to start unless the event's target IS that element.
Almost every draggable in this app is a div or an li with no tabindex, which no reader can focus.
The one exception is the category grip, which is a real button and a declared handle — and which
already carries the whole keyboard reorder on its own arrow keys.

Nothing changes behaviour here. Every assertion is a measurement, and one that starts failing
later is news about the markup rather than a defect: the decision 3c takes next is only as good as
the facts under it."
```

---

### Task 4: Decide the sensors, and make the one keyboard path that exists safe

**Files:**
- Modify: `src/lib/dndManager.ts` — the `sensors` list and the `Accessibility` comment
- Modify: `src/lib/dndAccessibility.test.ts` — the expectations that change, and why
- Modify: `src/features/decks/categoryDrag.ts` and/or `src/features/decks/views/StackView.tsx` and
  `src/features/decks/CategoriesDialog.tsx` — only if the chosen option touches the grip

**Interfaces:**
- Consumes: Task 3's measurement.
- Produces: a sensor list this app chose, and a comment that says what a keyboard can and cannot
  do in it.

> **The decision this task takes.** Task 3 will have established that a keyboard drag is
> unreachable on every draggable except the category grip, and that on the grip it *collides* with
> a shipped arrow-key reorder that is better than what a 10px-per-press drag could offer. Three
> options follow, and the evidence decides between them rather than taste:

**Option A — drop `KeyboardSensor`.** One line in `dndManager.ts`. Nothing in the app loses a
capability, because nothing has one: no draggable a reader can focus except the grip, and the
grip's own arrow keys are a better gesture than a drag. What it buys is that Space and Enter on the
grip go back to meaning what a `<button>` means, and that no future draggable silently acquires a
half-working keyboard drag by gaining a `tabindex`. **What it costs is honesty about the ceiling:**
after this the app has no general keyboard drag and every future gesture owes its own keyboard
path, the way the grip and `Move to` already do.

**Option B — keep `KeyboardSensor` and give it a `preventActivation` of the app's own**, refusing
any source that has not opted in — the mirror of what `dndManager.ts` already does to
`PointerSensor` with `NOT_A_DRAG`. Then opt the grip *out*, and let a future surface opt in when it
has a keyboard story worth having. Costs a few more lines than A and keeps the door open.

**Option C — keep it as it is and make the grip a non-handle**, moving the drag activation onto
something a keyboard cannot reach. Rejected before it is measured: it makes the mouse gesture worse
to protect a keyboard gesture nobody can use, which is the wrong trade in both directions.

- [ ] **Step 1: Choose, on the evidence, and ask if the evidence does not decide**

If Task 3 found the grip collision real (Space starts a drag, or the arrows are read twice), **A
and B are both fixes and A is the recommendation** — a capability nothing can reach is not a
capability, and the second-cheapest way to keep a door open is to reopen it when there is something
to walk through.

If Task 3 found something unexpected — a draggable that *is* tab-reachable, or a keyboard drag
that works and lands correctly — **stop and put it to Markus through `AskUserQuestion`**, leading
with what was measured and with the recommendation labelled first. A working keyboard drag on a
shipped surface is a different decision from the one this task was scoped for.

- [ ] **Step 2: Implement the chosen option**

For **A**, `src/lib/dndManager.ts`:

```ts
  sensors: [
    PointerSensor.configure({
      preventActivation: (event) => {
        const { target } = event;
        return target instanceof Element && target.closest(NOT_A_DRAG) !== null;
      },
    }),
  ],
```

and replace the `KeyboardSensor` clause of the `Accessibility` comment — which currently reads
"`KeyboardSensor` is a *sensor* and stays: dragging a folder from the keyboard is unaffected" —
with what Task 3 measured:

```ts
  /**
   * **`KeyboardSensor` is dropped too, and for a reason the plugin comment above only half
   * covers.**
   *
   * That sensor binds its `keydown` to `source.handle ?? source.element` and refuses to start
   * unless the event's target **is** that element
   * (`KeyboardSensor.defaults.preventActivation` is `event.target !== (source.handle ?? source.element)`).
   * Measured across every draggable in this app on <date>: the folder tree's source is a `<div>`
   * with no `tabindex`, the collection's and the wishlist's are an `<li>` with none, and a deck
   * card's `<li>` is `tabIndex={-1}` — none of them is somewhere a reader can put the caret. So
   * the sensor has never been reachable, and "dragging a folder from the keyboard is unaffected"
   * described a capability that did not exist.
   *
   * **The one activator a keyboard does reach is the category grip, and there it was harmful.**
   * The grip is a `<button>` and a declared handle, so Space and Enter — the sensor's own start
   * codes — began a drag and `preventDefault`ed the press, while the four arrows were read both
   * by the sensor as 10px nudges and by the grip's own `onKeyDown` as a real reorder. That grip's
   * arrow keys are the app's keyboard reorder and are better than a 10px drag could be: they
   * write a move per press and say `Move <name>, <n> of <total>` so the reader hears where it
   * landed.
   *
   * **What this gives up, said plainly, because it is a ceiling rather than a gap:** this app has
   * no general keyboard drag, and every gesture that wants one owes its own — the way the grip's
   * arrows and the card menu's `Move to` already do. A future surface that wants the sensor back
   * should turn it on for its own source rather than for the window: `Draggable` takes a
   * `sensors` array, so one draggable can have a keyboard path without every other one acquiring
   * a half-working gesture the moment it gains a `tabindex`.
   */
```

- [ ] **Step 3: Update the measurements this changes, and say which**

`src/lib/dndAccessibility.test.ts`'s "says which draggables a keyboard can pick up" now has a
different answer for the grip. **Change the expectation and leave the test.** Add one assertion it
did not have: `dndManager` has exactly one sensor, and it is `PointerSensor` — so that a future
`sensors:` edit that reinstates a keyboard path is a red build rather than a silent change to what
Space means on every button that happens to be a handle.

```ts
it("has one sensor, and it is the pointer", () => {
  // `dndManager`'s sensors are not enumerable off the instance; assert the observable instead —
  // Space on a focused grip leaves `dndManager.dragOperation.status.idle` true.
});
```

> **Assert the observable, not the field.** `DragDropManager` exposes `plugins` as a flat array and
> does not expose its sensors, so a test reaching for the list would be reaching into a private
> and would break on an upgrade for a reason that is not the app's. Space on a focused grip leaving
> the operation idle is the same claim made where a reader can see it.

- [ ] **Step 4: Mutate**

1. Put `KeyboardSensor` back in the `sensors` array. **"has one sensor, and it is the pointer" must
   fail**, and so must "still reorders a pile with the arrow keys on its grip" **if** Task 3 found
   the double-read. If the second does not fail, say so in the report — it means the collision is
   narrower than Task 3 measured and the comment above must be narrowed to match.
2. Remove `PointerSensor.configure`'s `preventActivation` override. A test in
   `src/features/decks/deckDrag.test.ts` ("does not start from a press on the tile's own control")
   **must fail** — this is the app-wide press guard, and this task edits the block it lives in.

**If either survives, stop and report.**

- [ ] **Step 5: Re-assert every drag in the app**

```bash
npm run test:run > /tmp/after-3c-4.log 2>&1; grep -E "Test Files|Tests " /tmp/after-3c-4.log
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```
The whole suite, because this task edits the one manager every registration in the app is
attached to. Expected: unchanged except for `dndAccessibility.test.ts`'s new assertion.

- [ ] **Step 6: Commit**

```bash
npm run verify > /tmp/verify-3c-4.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-4.log
git add src/lib/dndManager.ts src/lib/dndAccessibility.test.ts
git commit -m "fix(dnd): the keyboard sensor goes, and the ceiling it hid is written down

It has never been reachable. KeyboardSensor binds its keydown to source.handle ?? source.element
and refuses to start unless the event's target IS that element, and every draggable in this app is
a div or an li a reader cannot focus — so 'dragging a folder from the keyboard is unaffected'
described a capability that did not exist.

The one activator a keyboard does reach is the category grip, and there the sensor was doing harm
rather than nothing: Space and Enter started a drag and preventDefaulted the press, and the arrow
keys were read twice — once as 10px nudges and once as the real reorder the grip has always
written. That reorder is the better gesture: a move per press, and a label saying where it landed.

What this gives up is a ceiling rather than a gap, and the comment says so: this app has no
general keyboard drag, and any gesture that wants one owes its own. A future surface can turn the
sensor on for its own Draggable rather than for the window — which is the difference between a
keyboard path somebody designed and one every element acquires the moment it gains a tabindex."
```

---

### Task 5: What a drag says — announcements the app owns

**Files:**
- Create: `src/lib/dndAnnounce.ts`
- Create: `src/lib/dndAnnounce.test.ts`
- Modify: `src/lib/dndManager.ts` — install it, beside the count chip and the `data-dragging` mark
- Modify: `src/lib/folderDrag.ts`, `src/features/decks/dnd.ts`, `src/features/decks/deckDrag.ts`,
  `src/features/collection/collectionDrag.ts`, `src/features/wishlist/wishDrag.ts`,
  `src/features/decks/categoryDrag.ts` — each gains one function saying what its payload is called

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces: a live region driven off `dndManager.monitor`, and a per-payload name for it to read.

> **This is the half of the `Accessibility` plugin worth having, and it has to be written rather
> than switched on.** The plugin's `announcements` option is fully overridable — it is
> `{ dragstart, dragend, dragmove?, dragover? }`, each `(event, manager) => string | undefined` —
> but its defaults say `Picked up draggable item ${source.id}`, and `source.id` in this app is
> `dndId()`'s counter, which `dndManager.ts` describes as "a registry key and nothing else". A
> reader would hear *"Picked up draggable item folder-source-3"*. So the plugin would supply the
> live region and the hidden instructions element — about fifteen lines — and nothing else, at the
> cost of the five DOM mutations Task 3 measured and 3a refused. **Writing the fifteen lines is the
> cheaper half of that trade, and it is the half that can say "Sol Ring" instead of a counter.**

> **What the app has never had.** `@atlaskit/pragmatic-drag-and-drop` ships no announcements
> either, so nothing regresses by not doing this and nothing is being restored. This is new, and
> it is the first thing in this whole migration that a reader gains rather than keeps.

- [ ] **Step 1: Decide the sentences before writing the plumbing**

A drag has three moments worth saying and one worth not saying. Write them down first, in
`src/lib/dndAnnounce.ts`'s doc comment, then build to them:

- **Pick up:** what was picked up, by its own name. *"Picked up Sol Ring."* / *"Picked up the
  Ramp pile."* / *"Picked up the Standard folder."*
- **Over:** where it would land, only when that changes. *"Over Artifacts."* / *"Over the Trade
  binder folder."* / *"Not over anywhere it can go."*
- **Drop:** what happened. *"Sol Ring added to Artifacts."* / *"Cancelled."*
- **Not** every `dragmove`. The plugin debounces `dragover`/`dragmove` at 500ms for a reason, and
  this app does not need `dragmove` at all: the position is not news, only the target is.

- [ ] **Step 2: Write the failing tests**

```ts
import { afterEach, describe, expect, it } from "vitest";
import { Draggable } from "@dnd-kit/dom";
import { dndId, dndManager, registerNow } from "@/lib/dndManager";
import { DND_LIVE_REGION } from "@/lib/dndAnnounce";
import { folderDragData } from "@/lib/folderDrag";
import { startPointerDrag } from "@/test-drag";

const region = () => document.querySelector<HTMLElement>(`[${DND_LIVE_REGION}]`);

describe("what a drag says", () => {
  it("mounts one live region, and only one however many drags happen", async () => {
    const first = await startPointerDrag(mountSource());
    await first.cancel();
    const second = await startPointerDrag(mountSource());
    await second.cancel();
    expect(document.querySelectorAll(`[${DND_LIVE_REGION}]`)).toHaveLength(1);
  });

  it("is a polite live region a screen reader will read and a mouse will never see", () => {
    const live = region();
    expect(live).toHaveAttribute("aria-live", "polite");
    expect(live).toHaveAttribute("role", "status");
    // `.sr-only`'s job, spelled inline for the same reason the count chip's styles are inline:
    // this element is appended to `document.body` and cannot depend on a stylesheet having
    // reached it.
    expect(live?.style.position).toBe("absolute");
  });

  it("names the folder that was picked up, not its registry id", async () => {
    const held = await startPointerDrag(mountSource());
    expect(region()?.textContent).toBe("Picked up the Standard folder.");
    await held.cancel();
  });

  it("says where a drop would land, and says when it would not", async () => {
    // Mount a target that accepts, move over it, assert; move away, assert the "nowhere" line.
  });

  it("says what happened on the drop, and says cancelled on Escape", async () => {
    // Two gestures, two sentences.
  });

  it("says nothing for a drag it has no name for", async () => {
    // A Draggable carrying a record no feature claims. The region must not be updated at all —
    // not updated to an empty string, which would still interrupt a screen reader mid-sentence.
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -- src/lib/dndAnnounce.test.ts 2>&1 | tail -20`
Expected: the file fails to resolve `@/lib/dndAnnounce`.

- [ ] **Step 4: Implement**

`src/lib/dndAnnounce.ts` owns the region and the plumbing; it owns **no sentences about any
feature**. Each payload module gains one exported function — `folderDragName`, `cardDragName`,
`deckDragName`, `collectionDropName`, `wishDragName`, `categoryDragName` — taking the untyped
record and answering a name or `null`, exactly the shape their `read*` functions already have:

```ts
import type { DragDropManager } from "@dnd-kit/dom";

/** The attribute the region carries. Not a class: the element is appended to `document.body` and
 *  is styled inline for the count chip's reason — a stylesheet may not have reached it. */
export const DND_LIVE_REGION = "data-dnd-announce";

/**
 * What a drag says out loud, and the one place in this app that decides it.
 *
 * **Written rather than switched on.** dnd-kit's `Accessibility` plugin has a live region and an
 * `announcements` option that is fully overridable — but its defaults read out `source.id`, which
 * here is `dndId()`'s counter, and the plugin's *other* half rewrites the DOM of every draggable
 * in ways this app's markup cannot take (`docs/reference/frontend-design.md` has the measurement).
 * The region and the sentences are about fifteen lines; the mutations are not negotiable. So this
 * is those fifteen lines.
 *
 * **A name per payload, supplied by the payload's own module.** This file knows how to speak and
 * nothing about what any drag *is* — a folder is named by `folderDrag.ts`, a card by `dnd.ts`, a
 * pile by `categoryDrag.ts` — which is the same division `readFolderDrag` and `readDragData`
 * already draw at the boundary with the library's untyped store. A drag no namer claims says
 * **nothing at all**, and not an empty string: writing an empty string into a live region
 * interrupts whatever a screen reader was in the middle of.
 *
 * **`dragover` and not `dragmove`.** Where the pointer is is not news; what it is over is. The
 * plugin debounces the two together at 500ms because it publishes both; this publishes only the
 * one that carries a fact, so there is nothing to debounce.
 */
export function installDragAnnouncements(
  manager: DragDropManager,
  namers: {
    source: (data: Record<string, unknown>) => string | null;
    target: (data: Record<string, unknown>) => string | null;
  },
): () => void {
  let region: HTMLElement | null = null;
  let last = "";

  const say = (sentence: string) => {
    if (!region || sentence === last) return;
    last = sentence;
    region.textContent = sentence;
  };

  const ensure = () => {
    if (region?.isConnected) return;
    region = document.createElement("div");
    region.setAttribute(DND_LIVE_REGION, "");
    region.setAttribute("role", "status");
    region.setAttribute("aria-live", "polite");
    region.setAttribute("aria-atomic", "true");
    // `.sr-only`, inline. See the module comment.
    Object.assign(region.style, {
      position: "absolute",
      width: "1px",
      height: "1px",
      margin: "-1px",
      padding: "0",
      overflow: "hidden",
      clip: "rect(0 0 0 0)",
      whiteSpace: "nowrap",
      border: "0",
    });
    document.body.append(region);
  };

  const off = [
    manager.monitor.addEventListener("dragstart", ({ operation }) => {
      const name = operation.source ? namers.source(operation.source.data) : null;
      if (name === null) return;
      ensure();
      say(`Picked up ${name}.`);
    }),
    manager.monitor.addEventListener("dragover", ({ operation }) => {
      if (!operation.source || namers.source(operation.source.data) === null) return;
      const where = operation.target ? namers.target(operation.target.data) : null;
      say(where === null ? "Not over anywhere it can go." : `Over ${where}.`);
    }),
    manager.monitor.addEventListener("dragend", ({ operation, canceled }) => {
      const name = operation.source ? namers.source(operation.source.data) : null;
      if (name === null) return;
      if (canceled) {
        say("Cancelled.");
        return;
      }
      const where = operation.target ? namers.target(operation.target.data) : null;
      say(where === null ? `${name} dropped.` : `${name} dropped on ${where}.`);
    }),
  ];

  return () => {
    for (const stop of off) stop();
    region?.remove();
    region = null;
    last = "";
  };
}
```

In `src/lib/dndManager.ts`, install it beside the count chip, composing the namers from each
feature:

```ts
installDragAnnouncements(dndManager, { source: dragSourceName, target: dropTargetName });
```

where `dragSourceName` and `dropTargetName` live in a small `src/lib/dndNames.ts` that asks each
feature's namer in turn and answers the first non-`null`. **That file, not `dndAnnounce.ts`, is
what imports from `features/`** — the same one-way arrangement `dragPreview.ts` takes the manager
as an argument for.

> **A drop target has a name only where the surface gave it one.** `Droppable`'s `data` is empty
> for most targets in this app — `useDndDropTarget` registers with an `accept` and no record. So
> either the targets that want to be spoken about pass a `data: { name: "Artifacts" }`, or
> `dropTargetName` reads the element's `aria-label`. **Prefer the `aria-label`**: it is already
> there, it is already the name the reader hears when they Tab to that element, and two names for
> one thing is how they drift. `useDndDropTarget` gains no new option; `dropTargetName` takes the
> `Droppable` and reads `droppable.element?.getAttribute("aria-label")`, falling back to `null`.
> Say this in the comment, and give it a test: a target with no label produces *"Not over anywhere
> it can go"* rather than *"Over null"*.

- [ ] **Step 5: Run and mutate**

```bash
npm run test -- src/lib/dndAnnounce.test.ts 2>&1 | tail -12
```

Then:

1. Remove the `sentence === last` guard in `say`. **"mounts one live region, and only one" is
   unaffected — write the test that is:** two `dragover`s onto the same target must write the
   region once. If no test fails, add it, because a live region rewritten with the same text is a
   screen reader repeating itself.
2. Change the `if (name === null) return;` in `dragstart` to `if (false) return;`. **"says nothing
   for a drag it has no name for" must fail.**
3. Make `ensure()` create a new element each time. **"mounts one live region" must fail.**

**If any survives, stop and report.**

- [ ] **Step 6: Re-assert every drag, and every test that counts elements**

```bash
npm run test:run > /tmp/after-3c-5.log 2>&1; grep -E "Test Files|Tests " /tmp/after-3c-5.log
npm run test -- src/stories.test.tsx 2>&1 | tail -8
```

**This task appends an element to `document.body` during every drag**, which is exactly the kind of
change that breaks a test counting `role="status"` regions or asserting on `document.body`'s
children. `src/components/AppShell.tsx` already draws a `role="status"` note for a sidebar drop
report, and `AppShell.test.tsx` reads it. Expect a failure there and fix it by narrowing the
query, not by removing the region.

- [ ] **Step 7: Commit**

```bash
npm run verify > /tmp/verify-3c-5.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-5.log
git add src/lib/dndAnnounce.ts src/lib/dndAnnounce.test.ts src/lib/dndNames.ts src/lib/dndManager.ts src/lib/folderDrag.ts src/features/decks/dnd.ts src/features/decks/deckDrag.ts src/features/decks/categoryDrag.ts src/features/collection/collectionDrag.ts src/features/wishlist/wishDrag.ts
git commit -m "feat(dnd): a drag says what it is carrying and where it would land

The first thing in this migration a reader gains rather than keeps. pragmatic-dnd shipped no
announcements, so nothing is being restored — and dnd-kit's Accessibility plugin would have
supplied a live region and then said 'Picked up draggable item folder-source-3', because
source.id in this app is a registry counter and nothing else. Its announcements option is fully
overridable; its five DOM mutations are not. So the fifteen lines are written here and the
mutations stay refused.

Who names a payload is the same division the readers already draw: this file knows how to speak
and nothing about what any drag is. A folder is named by folderDrag.ts, a card by dnd.ts, a pile
by categoryDrag.ts, and a drag no namer claims says nothing at all — not an empty string, which
interrupts whatever a screen reader was in the middle of.

A drop target is named by its own aria-label rather than by a second name passed at registration.
It is already there, it is already what a reader hears when they Tab to it, and two names for one
thing is how they drift."
```

---

### Task 6: Drive it with a screen reader, and close the record

**Files:**
- Modify: `docs/reference/frontend-design.md` — the drag section, finished
- Modify: `src/CLAUDE.md` — one line, if the rules changed
- Modify: `CLAUDE.md` — only if the reference table needs a new row

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the migration's closing record, and the honest statement of what it does not do.

> **A live region is the one thing in this app that no test and no CDP pass can verify.** jsdom
> asserts the attributes; a browser asserts the element is there; only a screen reader asserts that
> anything is said. Windows ships Narrator, so there is no install to argue about.

- [ ] **Step 1: Take the app lock and run a real screen reader**

Build a debug binary — `npm run tauri build -- --debug --no-bundle` — because this is also the last
chance to confirm the shipped CSP is still satisfied, and `tauri dev` **sends no CSP at all**
(Vite serves the page and Tauri is out of the response path), so it can refute nothing about it.

Start Narrator (`Ctrl+Win+Enter`) and drive, with the mouse:

1. A folder from the collection wall onto another folder.
2. A card from the search panel into a deck pile.
3. A card onto the sidebar's Decks entry, and onto Wishlist.
4. A drag released over nothing, and a drag cancelled with Escape.

Record what was **actually spoken**, verbatim, including anything spoken twice and anything not
spoken at all. A sentence written in Task 5 and not heard here is a defect; a sentence heard twice
is the `sentence === last` guard not covering a case the suite does not produce.

- [ ] **Step 2: Tab the whole app once, and count the stops**

The `Accessibility` plugin would have added a tab stop per draggable. It is not installed, so the
count should be what it was before this whole migration began. Tab through the collection wall, a
deck's piles and the sidebar, and record the stops. **If a stop appeared, something is stamping a
`tabindex`** and Task 3's assertion did not catch it.

- [ ] **Step 3: Fix what the pass found, or record it as open**

A defect found here gets fixed here if it is one of Task 5's sentences. Anything larger — a
gesture that is unusable with a screen reader for a reason no sentence fixes — is recorded as
**open** in `docs/reference/decks-live-findings.md`, with what was tried. That file already carries
open bugs; an honest open entry is worth more than a fix invented at the end of a plan.

- [ ] **Step 4: Finish the drag section of `frontend-design.md`**

By this point that section has been written by 3a (against a spike and one domain), corrected by
3b's live pass and by 3c Task 2, and extended by Task 3. Read the whole of it and make it one
document rather than four appended ones. It must end able to answer, without the reader going to
the code:

- what library this app drags with, why the imperative path rather than the hooks, and where the
  one manager lives;
- what jsdom cannot do and the six shims that fix it;
- why the library's own stylesheet is copied into `index.css` and what fences the copy;
- why two `Droppable`s on one element are legal and what actually keeps them apart;
- why overlapping targets need a `collisionPriority` and what decides them without one;
- what a drag is to a keyboard and to a screen reader, what was refused, and **what this app
  therefore does not do**.

The last one is the one a document like this usually leaves out.

- [ ] **Step 5: Check the two `CLAUDE.md` files still tell the truth**

`src/CLAUDE.md` carries the layers, the card-image rules and the tab-stop rule. Grep it for
`pragmatic`, `drag` and `dnd`; correct anything that names a library that is gone. The root
`CLAUDE.md` names reference docs in a table — add no row for a doc that already has one, and
remember that **a prose-only edit routes to neither CI job**, so a count written into either file
is a count nothing will ever check. Do not write one down.

- [ ] **Step 6: Release the lock and commit**

```bash
npm run verify > /tmp/verify-3c-6.log 2>&1; grep -E "Test Files|Tests " /tmp/verify-3c-6.log
git add docs/reference/frontend-design.md docs/reference/decks-live-findings.md src/CLAUDE.md
git commit -m "docs(dnd): the migration's record, including what it does not do

A live region is the one thing here no test and no CDP pass can verify: jsdom asserts the
attributes, a browser asserts the element exists, and only a screen reader asserts that anything
is said. Narrator against a tauri build --debug binary is what these sentences were checked with,
and what was actually spoken is written down verbatim — including anything said twice.

frontend-design.md's drag section had been written four times by four passes: a spike, one domain,
a live pass and a removal. It is one document now, and it ends on the question a document like
this usually leaves out — not what the app does for a reader without a mouse, but what it does
not."
```

---

## Self-Review

**Spec coverage.** Closes spec §6.4: `pragmatic-drag-and-drop` is gone from the manifest, the
tree and the harness, and the desktop-first migration is complete. What §6.4 does **not** ask for
and this plan does not do: touch support. dnd-kit's `PointerSensor` already has a touch path — a
250ms delay with 5px tolerance, in its default `activationConstraints` — but nothing in this repo
has ever been driven on a touch screen, and pretending otherwise would put an unmeasured claim
into a document whose whole value is that its claims are measured. Phase 4 and Phase 5 own that.

**Where this plan takes a decision rather than inheriting one.** 3a removed `Accessibility` and
Markus said "revisit in 3c". Tasks 3–5 are that revisit, and they split it into a measurement, a
sensor decision and a thing built — rather than into "put the plugin back, yes or no", which is not
the question the code actually poses. The plugin's DOM mutations and its announcements are two
separable halves with opposite verdicts, and no amount of reading 3a would have said so: it took
reading `registerEffect` and the `Announcements` type.

**The finding that most changes the shape of Task 4.** 3a's comment says "`KeyboardSensor` is a
*sensor* and stays: dragging a folder from the keyboard is unaffected". Read out of
`node_modules/@dnd-kit/dom/index.js` on 2026-08-28, `KeyboardSensor.defaults.preventActivation` is
`event.target !== (source.handle ?? source.element)` and `bind` listens only on that element — and
every draggable in this app is a `<div>` or an `<li>` with no `tabindex` or with `tabIndex={-1}`.
So the sentence describes a capability that does not exist. Task 3 measures it rather than
asserting it from here, because a plan that fixed a comment on my reading of a bundle would be the
same mistake in the other direction.

**Placeholders.** Task 3's Step 2 leaves four test *bodies* as comments and that is deliberate and
bounded: each names the assertion it must make and the existing test file whose helpers it must
reuse, and the surrounding text forbids softening an assertion to make it pass. Inventing a second
way to render `CollectionFolderCard` here — without the fixtures, the fake and the wrapper its own
suite has — would produce a worse test than the one that gets written by reading that file. Every
other step in this plan names the file, the symbol and the expected output.

**Type consistency.** `installDragAnnouncements(manager, { source, target })` takes the manager as
an argument for `installCardCountPreview`'s reason: `dndAnnounce.ts` must not import
`dndManager.ts`, or the two are circular. `dndNames.ts` is the one file that imports from
`features/`, which is the same one-way arrangement 3b's Task 4 established. `DND_LIVE_REGION` is a
string constant used by the module and its test and nowhere else. The `namers.target` signature
takes a record, and the note at Step 4 changes it to take the `Droppable` so it can read an
`aria-label` — **that change is made in the code, not left implied**: whoever executes Step 4 must
write `target: (droppable: Droppable) => string | null` and adjust both call sites in the same
edit.

**The honest risk.** Task 5 adds an element to `document.body` on every drag and appends nothing at
rest, which is the least invasive shape available — but the app already draws a `role="status"`
region in the sidebar, and a test somewhere queries by that role without narrowing. Step 6 expects
that failure by name. The second risk is Task 4: dropping a sensor is a one-line change with no
natural red, which is why its mutation step puts the sensor back and requires two named tests to
fail. If only one of them does, the comment being written is wider than the evidence and has to be
narrowed before it ships — a comment that overstates what was measured is the failure this whole
plan exists to correct.
