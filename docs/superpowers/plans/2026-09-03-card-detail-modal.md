# Card Detail Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all three mounts of the docked `CardDetailPane` with one centred modal on `Dialog`, with four stackable nested overlays and four container-query breakpoints.

**Architecture:** One `CardDetailModal` mounted at `App` level reads `selectedCardId` and draws a three-part grid inside `Dialog`'s panel — card and prices left, controls centre, an options rail right, an action row at the foot. Four overlays (printings, legality, oracle tags, card text) open *over* it as App-level siblings, never as children, because the panel is a container-query context and would capture their `fixed` scrims. Breakpoints are container queries measured on the panel, not viewport branches.

**Tech Stack:** React 19, TypeScript 6, Tailwind v4 (container queries), `motion@13.1.0`, TanStack Query + Virtual, Zustand, Vitest + Testing Library, Storybook.

**Spec:** `docs/superpowers/specs/2026-09-03-card-detail-modal-design.md` — read it first; every task argues from it.

## Global Constraints

These apply to **every** task. They are the house rules that a fresh implementer gets wrong.

- **Do not run `npm run verify`, `npm run build`, or the full Vitest suite.** Tests run once, after fan-in, by the coordinator. A slice compiles against a tree its siblings are still changing, so a suite run mid-fan-out fails for reasons that are not its own. Run *only* your own test file: `npx vitest run <path>`.
- **Do not `git add` or `git commit`.** Parallel agents in one worktree share the git index, and a commit sweeps siblings' half-finished work. Report what you changed; the coordinator commits.
- **Tailwind scans source text for whole class names.** A class built by interpolation or template literal emits **no rule at all** — silently, and only in a build. Every width, height, breakpoint and container class is written out whole.
- **Never install `@types/node`.** It retypes `setTimeout` and leaks Node types into the app program.
- **No `setState` inside an effect** — it fails lint only at `npm run verify`, which you are not running. Use `useSyncExternalStore`, derive during render, or an event handler.
- The app is **dark-only**. No light-mode branches.
- Imports: `cn` from `@/lib/utils`, `FOCUS` from `@/lib/focus`, `LAYER` from `@/lib/layers`, motion presets from `@/lib/motion`. Never hand-roll a z-index, a focus ring, or a duration.
- **Prettier is not the formatter for `src/`.** Do not run a global prettier pass; it rewrites 126 files.
- Every new component gets a `.test.tsx`. Cover logic that can break — no ceremony tests.
- **jsdom has no layout engine.** Container queries resolve to nothing and every box is 0. Never assert a computed size; assert the *class* is present.

### Corrections found during wave 1 — read these before writing a fixture

- **`PaneDeckContext` has six required fields, not four.** An earlier draft of this plan gave a
  four-field fixture with `variant: "main"`, and both are wrong: `DeckVariant` is
  `"live" | "theory"` (`ipc.ts:1494`), and `finish: DeckFinish` is required too. The correct
  fixture, which Tasks 8, 9 and 10 all need:
  ```ts
  const deckRow: PaneDeckContext = {
    deckId: 1, categoryId: 2, categoryName: "Burn spells",
    cardId: "c1", variant: "live", finish: null,
  };
  ```
- **`cn` is `twMerge`, so same-variant classes collapse to the last one.** This matters for the
  card modal's `size` string in Task 10: `w-full` and `@[640px]/card:w-[47.75rem]` survive
  together because their variants differ, but two widths at the *same* variant would silently
  leave only the second. Check any multi-rung class string you build for this.
- **`grep "<Dialog"` does not find every host.** `Dialog.stories.tsx` passes props through an
  `args` object and was missed by exactly that search in wave 1. Grep the prop name too.
- **`Dialog` gained a `layer` prop in wave 1** — see Task 3, which is the first host to pass it.

### Corrections found during wave 2

- **`CardTags` has `slugs: string[]`, not `tags`.** An earlier draft's fixture did not compile.
- **`cardDetailKey` is now spelled out in four places** — the pane and the three new overlays — each
  having copied it rather than importing from the doomed `CardDetailPane.tsx`. **Task 11 must hoist
  it to a shared module** as part of deleting that file, or the key drifts and each overlay
  silently pays its own round trip instead of sharing one cache entry.
- **`StepChevron` does not return null on a null stop** and must not be made to — see Task 10.
- **`CardDetail` carries no `power`, `toughness` or `loyalty`**, so the card text dialog ships
  without them. Decided 2026-09-03; spec §3.2 records the gap. Do not add a substitute.
- **`App.test.tsx` mocks `oracleTagsStatus` and `oracleTagsForPrintings` but not
  `oracleTagsForCards`.** Task 11's Escape-ladder test opens **Legality**, which needs neither — but
  if it is ever rewritten to open Oracle tags instead, that mock has to be added first.
- **Story `play` functions were deliberately not written during the fan-out.** `stories.test.tsx`
  globs the whole tree, so it cannot be run mid-wave and an unverifiable `play` is a live risk to
  the coordinator's `verify`. The new stories are visual states only.
- **Container queries are spelled `@min-[640px]/name:` in this repo, not `@[640px]/name:`.**
  Every rung in this plan was written the second way; `FilterBar` and `FilterChips` — the only
  existing named containers — use the first. Wave 2 compiled **both** against this build (Tailwind
  4.3.3) with the CLI and they emit identical CSS, so this is a house-style choice rather than a
  correctness fix. **Use `@min-[…]` anyway**, so `src/` has one spelling and a grep for either rung
  finds every site.
### Corrections found during wave 3 — Task 10 must act on all of these

- **THE GRIMOIRE COUNTS ARE SHOWN AT EVERY RUNG. This plan said otherwise and was wrong.**
  Task 9 was told the counts are `hidden @min-[1200px]/card:flex`, which deletes them at three
  rungs out of four. Re-read against the artboards: **all four show them**, and §2.1's "no grimoire
  counts in the rail" at `@[900px]` means they *move*, not that they vanish.

  | rung | where the counts sit |
  | --- | --- |
  | `≥1200` | in the rail, vertical, under an "In your grimoire" heading |
  | `900–1200` | an inline row in the **centre** column, after the Tag control |
  | `640–900` | an inline row in the **left** column, under the prices |
  | `<640` | an inline row in the single-column stack |

  `CardModalRail`'s own class is therefore **correct and stays**. What is missing is the other half:
  **Task 10 draws an inline counts row, `@min-[1200px]/card:hidden`**, so exactly one of the two is
  visible at every width. Drawing it once in the controls column satisfies three rungs at once (at
  `<640` the stack is one column anyway); the 640–900 artboard puts it under the prices instead,
  which is a placement refinement rather than a content difference.

  **Without this the counts silently disappear below 1200px with every test green.**

- **`CardModalArt`'s props are not what this plan named.** `deckFinish: DeckFinish | null` cannot
  be written: `DeckFinish` is already `Exclude<Finish,"nonfoil"> | null`, so the union collapses and
  cannot distinguish "no deck row" from "a deck row playing a regular copy" — which is exactly the
  distinction the `Set as …` / `View as …` label turns on. The prop is **`deckRow: { finish:
  DeckFinish } | null`**, which a `PaneDeckContext` satisfies structurally, so pass `scope.deck`
  unchanged. And **`onToggleFoil` takes the next finish** (`(next: DeckFinish) => void`), because a
  zero-arg handler cannot tell the host whether to write `foil`/`etched` or `null` to the deck row.

- **`CardModalArt` does not read the store, by design.** The docked pane seeded its foil view from
  `paneFinish` as well as from the deck row — a card opened from a collection tile that *is* foil.
  This component is presentational and has no seat for that. **If that behaviour is wanted, Task 10
  passes a seed prop**; otherwise it is a deliberate regression and should be recorded as one.

- **`RailCounts` needs `deck: number | null`.** The `4×` in the deck line is on neither `counts` nor
  `CardModalScope`, and `PaneDeckContext` holds a *slot*, not a quantity. Task 10 has the deck in
  hand and passes it.

- **The deck line reads `4× in Burn spells · Actual`, not `4× in Burn · mainboard`.** This app has
  no mainboard/sideboard concept — `DeckVariant` is `"live" | "theory"` and the words on screen are
  **Actual / Theory**. `PaneDeckContext` also carries no deck *name*, only `categoryName`. To name
  the deck, Task 10 must pass it.

- **`CardModalControls` takes nine props this plan's interface never listed, and Task 10 must wire
  every one of them.** The Task 8 sketch named only `card`, `scope`, `printingCount` and
  `onViewAllPrintings` — nothing to populate the printing, category or tag dropdowns, nothing to
  give the stepper a value, and nothing to call. Wave 3 added them **optional with inert
  defaults**, so the component renders bare for its own test: `printings` / `onPickPrinting`,
  `quantity` / `onQuantityChange`, `categories` / `onPickCategory`, `tags` / `tagId` / `onPickTag`.
  **An unwired handler is silently inert** — the control draws, the reader presses it, and nothing
  happens, with nothing going red. Task 10's review must check all nine.
- **The deck card's coloured mark is a LABEL, not a tag** (corrected 2026-09-03 after a merge from
  `main` renamed it mid-flight). The field is `DeckCard.labelId`, the writer is
  `ipc.deckCardSetLabel`, the tables are `deck_labels` / `deck_cards.label_id`, and the dialogs are
  `LabelsDialog` / `AddLabelDialog`. The root `CLAUDE.md` now reserves **tag** for Scryfall's two
  Tagger datasets and the collection's free-text `tags` column, and says in bold: *"Never let the
  words trade places."*

  `CardModalControls` shipped in wave 3 calling it a Tag with `tagId` / `onPickTag`. That
  **type-checked**, because the props are declared locally rather than off `DeckCard` — so a host
  could have wired `labelId` into a prop named `tagId` with nothing going red. Renamed to
  `labelId` / `onPickLabel` / `labels`.

  **The rail's "Oracle tags" entry is correct and stays** — those really are Scryfall tags.

- **The label picker is single-select.** `DeckCard.labelId` is `number | null`, so a deck row wears
  at most one: a `Dropdown` with `""` for none, never a multi-select.
- **Format display names do not come from `FORMAT_ORDER`** — it is 23 bare keys and nothing else.
  `format_specs` looks like the right source and was tried and backed out in wave 2: the Storybook
  fake serves 12 of its 25 rows by design, so a 23-row grid through it renders half its rows as raw
  slugs. `LegalityDialog` carries a local label map; reuse that rather than re-deriving one.

---

## File Structure

| File | Responsibility | Task |
| --- | --- | --- |
| `src/components/Dialog.tsx` | modal shell: full-bleed fold, opt-in container, `size` prop | 1 |
| `src/lib/layers.ts` | the `overlayStacked` rung split | 2 |
| `src/lib/store.ts` | open-state for the three new overlays | 2 |
| `src/features/card/cardModalScope.ts` | **new** — the per-view rule, in one testable place | 2 |
| `src/features/card/StepChevron.tsx` | **new** — extracted from `AllPrintingsDialog` | 3 |
| `src/features/card/LegalityDialog.tsx` | **new** — the format grid | 4 |
| `src/features/card/OracleTagsDialog.tsx` | **new** — tag pills | 5 |
| `src/features/card/CardTextDialog.tsx` | **new** — type line, oracle text, P/T, rarity | 6 |
| `src/features/card/CardModalArt.tsx` | **new** — left column: image, chin, foil/flip, prices | 7 |
| `src/features/card/CardModalControls.tsx` | **new** — centre column: quantity, printing, category, tag | 8 |
| `src/features/card/CardModalRail.tsx` | **new** — right rail: options list, grimoire counts | 9 |
| `src/features/card/CardDetailModal.tsx` | **new** — the host: `Dialog`, header, grid, action row, flanks | 10 |
| `src/App.tsx` | mount the modal and the three overlays; delete the dock | 11 |
| `src/features/decks/DeckEditor.tsx` | delete the sticky overlay frame | 11 |
| `src/features/card/CardDetailPane.tsx` | **deleted** once its parts have moved | 11 |

## Wave Schedule

Tasks in one wave touch **no file in common** and run in parallel. Do not start a wave until the previous one has landed.

| wave | tasks | why together |
| --- | --- | --- |
| 1 | 1, 2 | foundations everything else imports; no shared file |
| 2 | 3, 4, 5, 6 | all consume wave 1; each owns its own new file |
| 3 | 7, 8, 9 | the three columns; each owns its own new file |
| 4 | 10 | the host, imports waves 2–3 |
| 5 | 11 | wiring and deletion; touches `App.tsx` and `DeckEditor.tsx` |

---

### Task 1: `Dialog` — full-bleed fold, opt-in container, size prop

**Files:**
- Modify: `src/components/Dialog.tsx`
- Modify: `src/components/Dialog.test.tsx`
- Modify: every `<Dialog` call site, one line each — the `width=` → `size=` rename. Find them with `grep -rln "<Dialog" src --include=*.tsx`.

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  export interface DialogProps {
    // ... every existing prop unchanged except:
    /**
     * The panel's Tailwind **size** classes, written out whole — e.g. `"w-[77.5rem] h-[50rem]"`.
     * Renamed from `width` on 2026-09-03: the card modal sets a height per rung, and a prop
     * called `width` carrying `h-…` is a name that lies. Still a class string the host spells
     * out, for Tailwind's whole-name scan.
     */
    size: string;
    /**
     * Make the panel a named container-query context, `@container/card`.
     *
     * Opt-in, never on by default: `container-type` implies layout containment, which makes the
     * element a containing block for its `fixed` descendants — so a dialog body that renders a
     * `fixed` overlay would have it resolve against the panel instead of the window. One host
     * asks for this today.
     *
     * The name is the literal `card` rather than a value from this prop, because a class built
     * from a prop matches nothing Tailwind's scanner knows.
     */
    container?: boolean;
  }
  ```

- [ ] **Step 1: Write the failing tests**

Add to `src/components/Dialog.test.tsx`. Use the file's existing render helper and query style.

```tsx
it("goes full-bleed below the phone fold and framed above it", () => {
  const { container } = renderDialog({ size: "w-[30rem]" });
  const scrim = container.querySelector(".fixed.inset-0") as HTMLElement;
  const panel = screen.getByRole("dialog");

  // The scrim's inset is zero below `sm` and 24px at and above it. `p-4` is gone: `sm` is
  // 640px, which is this fold exactly, so an intermediate rung would emit a rule for a
  // zero-width range.
  expect(scrim.classList.contains("p-0")).toBe(true);
  expect(scrim.classList.contains("sm:p-6")).toBe(true);
  expect(scrim.classList.contains("p-4")).toBe(false);

  // The frame is the same fold: no rounding and no border on a panel that fills the glass.
  expect(panel.classList.contains("sm:rounded-xl")).toBe(true);
  expect(panel.classList.contains("sm:border")).toBe(true);
  expect(panel.classList.contains("rounded-xl")).toBe(false);
});

it("names a container on the panel only when the host asks", () => {
  const { unmount } = renderDialog({ size: "w-[30rem]" });
  expect(screen.getByRole("dialog").classList.contains("@container/card")).toBe(false);
  unmount();

  renderDialog({ size: "w-[30rem]", container: true });
  expect(screen.getByRole("dialog").classList.contains("@container/card")).toBe(true);
});
```

`classList.contains`, never `className.includes` — a substring test passes on
`sm:rounded-xl` when asked about `rounded-xl` and would make the third assertion of the first
test vacuous.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/Dialog.test.tsx`
Expected: FAIL — `p-0` absent, `@container/card` absent, and a type error on `size`.

- [ ] **Step 3: Implement**

In `Dialog.tsx`, rename the prop and its doc, then change the two class strings:

```tsx
// scrim — was "fixed inset-0 grid grid-rows-[minmax(0,1fr)] place-items-center bg-bg/75 p-4 sm:p-6"
"fixed inset-0 grid grid-rows-[minmax(0,1fr)] place-items-center bg-bg/75 p-0 sm:p-6",
```

```tsx
// panel — was "flex max-h-full max-w-full flex-col rounded-xl border border-border bg-bg shadow-2xl"
"flex max-h-full max-w-full flex-col bg-bg shadow-2xl",
"sm:rounded-xl sm:border sm:border-border",
container === true && "@container/card",
size,
```

Then update every call site: `width="…"` becomes `size="…"`. Pure rename, no value changes.

Keep `max-h-full` and the scrim's `grid-rows-[minmax(0,1fr)]` **exactly as they are** — that pair
is what makes the clamp mean anything, and the card modal's fixed heights all exceed the 700px
minimum window height, so it is load-bearing at every rung.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/Dialog.test.tsx`
Expected: PASS, including every pre-existing untouched-shape assertion.

- [ ] **Step 5: Mutation-check your own test**

Delete `container === true &&` so the class is always applied. Re-run. The second test must fail
on its first assertion. Restore. A test that passes both ways is testing nothing.

- [ ] **Step 6: Report** — list the files you changed and the call sites you renamed. Do not commit.

---

### Task 2: `LAYER` rung split, overlay state, and the per-view rule

**Files:**
- Modify: `src/lib/layers.ts`
- Modify: `src/lib/store.ts`
- Create: `src/features/card/cardModalScope.ts`
- Create: `src/features/card/cardModalScope.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  ```ts
  // layers.ts
  LAYER.overlay        === "z-45"  // unchanged value, doc updated
  LAYER.overlayStacked === "z-46"  // new
  LAYER.tooltip        === "z-47"  // moved from z-46

  // store.ts — three fields beside `printingsRequest`, each with one writer
  interface AppState {
    cardOverlay: CardOverlay | null;
    openCardOverlay: (overlay: CardOverlay) => void;
    closeCardOverlay: () => void;
  }
  /** Which overlay is open over the card modal. One field, so at most one is ever open —
   *  the same shape `printingsRequest` uses, and the printings modal stays separate because
   *  it already has its own field and its own walk. */
  export type CardOverlay = "legality" | "oracleTags" | "cardText";

  // cardModalScope.ts
  export type CardModalSurface = "search" | "collection" | "wishlist" | "tags" | "deck";
  export interface CardModalScope {
    surface: CardModalSurface;
    /** The deck row the card was opened out of, or null. */
    deck: PaneDeckContext | null;
    /** What the quantity stepper edits, or null for "do not draw one". */
    quantity: "deck" | "owned" | "wished" | null;
    /** Deck category and tag pickers, and the deck-only rail actions. */
    deckControls: boolean;
  }
  export function useCardModalScope(): CardModalScope;
  ```

- [ ] **Step 1: Write the failing test**

`src/features/card/cardModalScope.test.ts`. Drive the real store — `useAppStore.setState` — rather
than mocking it, so the test breaks if a field is renamed.

```ts
import { renderHook } from "@testing-library/react";
import { useAppStore } from "@/lib/store";
import { useCardModalScope } from "./cardModalScope";

const deckRow = {
  deckId: 1, categoryId: 2, categoryName: "Burn spells", cardId: "c1", variant: "main",
} as const;

it("reads the deck row before the view, because a card opened from a deck is a deck card", () => {
  // `activeView` still says "decks", but what decides is the row — a card opened from the
  // editor's docked search panel has no row and must not draw deck controls.
  useAppStore.setState({ activeView: "decks", paneDeckContext: deckRow });
  const { result } = renderHook(() => useCardModalScope());

  expect(result.current.surface).toBe("deck");
  expect(result.current.quantity).toBe("deck");
  expect(result.current.deckControls).toBe(true);
  expect(result.current.deck).toEqual(deckRow);
});

it("draws no stepper and no deck controls on the search page", () => {
  useAppStore.setState({ activeView: "search", paneDeckContext: null });
  const { result } = renderHook(() => useCardModalScope());

  expect(result.current.surface).toBe("search");
  expect(result.current.quantity).toBeNull();
  expect(result.current.deckControls).toBe(false);
});

it.each([
  ["collection", "owned"],
  ["wishlist", "wished"],
] as const)("binds the stepper to the %s count", (view, edits) => {
  useAppStore.setState({ activeView: view, paneDeckContext: null });
  const { result } = renderHook(() => useCardModalScope());

  expect(result.current.quantity).toBe(edits);
  expect(result.current.deckControls).toBe(false);
});
```

Reset the store between tests — moving state out of `useState` makes a suite order-dependent, and
this file writes module-level state. Use the file-level `beforeEach` pattern the other store tests
in this repo already use.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/features/card/cardModalScope.test.ts`
Expected: FAIL — `Cannot find module './cardModalScope'`.

- [ ] **Step 3: Implement all three files**

`cardModalScope.ts` — the whole per-view rule, and the only place it is written:

```ts
export function useCardModalScope(): CardModalScope {
  const deck = useAppStore((s) => s.paneDeckContext);
  const view = useAppStore((s) => s.activeView);

  // The row wins over the view, and the two disagree in a case that is not rare: the deck
  // editor's docked search panel opens cards that are *not* in the deck, so `activeView` is
  // "decks" while the card has no row. Deriving from the view alone would offer to set a
  // category on a card the deck does not hold.
  if (deck !== null) {
    return { surface: "deck", deck, quantity: "deck", deckControls: true };
  }
  const surface: CardModalSurface =
    view === "collection" ? "collection" : view === "wishlist" ? "wishlist" : view === "tags" ? "tags" : "search";
  const quantity = surface === "collection" ? "owned" : surface === "wishlist" ? "wished" : null;
  return { surface, deck: null, quantity, deckControls: false };
}
```

`layers.ts` — add `overlayStacked` between `overlay` and `tooltip`, move `tooltip` to `z-47`, and
**rewrite `overlay`'s doc**: the paragraph justifying one rung by "at most one is ever mounted" is
now false, and that doc itself says this is the day the rung splits. Say what the real overlap is
(a nested overlay over the card modal) rather than deleting the argument. `tooltip`'s doc keeps its
"above every dialog" reasoning — only the number moves.

`store.ts` — `cardOverlay`, `openCardOverlay`, `closeCardOverlay`, modelled on
`printingsRequest` / `openAllPrintings` / `closeAllPrintings` directly above. **`setSelectedCardId`
and every other card-clearing writer must also clear `cardOverlay`** — an overlay outliving the
card under it would be a legality grid for a card nobody has open. Find those writers by grepping
`selectedCardId: null` in `store.ts`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/features/card/cardModalScope.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Check the layer values are what you think**

Run: `npx vitest run src/lib` and confirm nothing that pins a z-index went red. If a test pins
`z-46` for the tooltip, update it — the move is intended.

- [ ] **Step 6: Report.** Do not commit.

---

### Task 3: Extract `StepChevron`

**Files:**
- Create: `src/features/card/StepChevron.tsx`
- Create: `src/features/card/StepChevron.test.tsx`
- Modify: `src/features/card/AllPrintingsDialog.tsx` — delete the local definition, import instead.

**Interfaces:**
- Consumes: Task 1's `size` prop rename (this file is a `Dialog` host).
- Produces:
  ```ts
  export function StepChevron(props: {
    direction: "previous" | "next";
    listLabel: string;
    stop: CardWalkStop | null;
    onStep: (stop: CardWalkStop) => void;
  }): JSX.Element | null;
  ```

- [ ] **Step 1: Move the component verbatim**

Cut `StepChevron` from `AllPrintingsDialog.tsx:303` — **the whole thing, comments included** — into
the new file. Export it. Do not redesign it, do not rename its props, do not "improve" its
accessible name. It is drawn at the app's 36px control height and the card modal reuses it as-is.

- [ ] **Step 2: Import it back**

In `AllPrintingsDialog.tsx`, add `import { StepChevron } from "./StepChevron";` and delete the
local definition. The two call sites (~495, ~503) are unchanged.

- [ ] **Step 3: Write the test**

The extraction is behaviour-preserving, so the test is about the contract the *new* consumer needs:

```tsx
it("renders nothing when there is no stop to step to", () => {
  const { container } = render(
    <StepChevron direction="next" listLabel="Search results" stop={null} onStep={vi.fn()} />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("names the list it walks, so the two chevrons are told apart", () => {
  render(
    <StepChevron direction="previous" listLabel="Search results" stop={stub} onStep={vi.fn()} />,
  );
  expect(screen.getByRole("button", { name: /previous.*search results/i })).toBeInTheDocument();
});
```

If the moved component does **not** already return null on a null stop, stop and report it —
that is the contract Task 10 depends on for hiding the chevrons, and it must not be invented here
without saying so.

- [ ] **Step 4: Move `AllPrintingsDialog` onto the stacked rung**

Found in wave 1, and it is the reason this task touches the file at all beyond the extraction.

This dialog is opened **two ways**: from a card menu over a bare view, and from the card detail
modal's `View all printings`. At `LAYER.overlay` the second case ties with the card modal it was
opened from, and equal z-indexes resolve by document order — which is the bug `layers.ts`'s opening
paragraph is a report of.

Wave 1 added a `layer` prop to `Dialog` for this. Pass the stacked value here — read `Dialog`'s
prop doc for the exact spelling, since wave 1 chose the union's member names. Add the reason as a
comment at the call site: a rung is a claim about the highest thing a surface can be asked to
cover, not about where it usually sits.

Do **not** change any other dialog's rung.

- [ ] **Step 5: Run both files**

Run: `npx vitest run src/features/card/StepChevron.test.tsx src/features/card/AllPrintingsDialog.test.tsx`
Expected: PASS. `AllPrintingsDialog.test.tsx` is the real check — it exercises the chevrons through
the dialog and must be green with no edits.

- [ ] **Step 6: Report.** Do not commit.

---

### Task 4: `LegalityDialog`

**Files:**
- Create: `src/features/card/LegalityDialog.tsx`, `.test.tsx`, `.stories.tsx`

**Interfaces:**
- Consumes: Task 1 (`size`, `Dialog`), Task 2 (`LAYER.overlayStacked`, `cardOverlay`).
- Produces: `export function LegalityDialog(): JSX.Element` — self-mounting, reads the store, drawn as an App-level sibling.

- [ ] **Step 1: Write the failing test**

The behaviour worth testing is the one that differs from every existing legality surface: this
popup draws `not_legal` rows, which `legalityChips` strips.

```tsx
const LEGALITIES = JSON.stringify({
  standard: "not_legal", modern: "legal", vintage: "restricted", historic: "banned",
});

it("draws every format including the ones the card is not legal in", async () => {
  // `legalityChips` drops `not_legal` before drawing and the docked pane said so in a caption.
  // This popup shows them, so it reads the JSON directly — a regression to `legalityChips`
  // here would silently lose 12 of 23 rows.
  renderWithCard({ legalities: LEGALITIES });

  expect(await screen.findByText("Standard")).toBeInTheDocument();
  expect(screen.getByText("Modern")).toBeInTheDocument();
  expect(screen.getByText("Vintage")).toBeInTheDocument();
  expect(screen.getByText("Historic")).toBeInTheDocument();
});

it("says the status in words, never in colour alone", async () => {
  renderWithCard({ legalities: LEGALITIES });

  // Each row's badge carries the word. A reader who cannot tell the green from the red still
  // gets the answer, which is the app's rule wherever a status is coloured.
  const banned = (await screen.findByText("Historic")).closest("li, div") as HTMLElement;
  expect(within(banned).getByText(/banned/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/features/card/LegalityDialog.test.tsx`. Expected: module not found.

- [ ] **Step 3: Implement**

```tsx
export function LegalityDialog() {
  const open = useAppStore((s) => s.cardOverlay) === "legality";
  const cardId = useAppStore((s) => s.selectedCardId);
  const close = useAppStore((s) => s.closeCardOverlay);
  // ... useQuery on cardDetailKey, exactly as CardDetailPane does — same key, so this shares
  // the cache entry and makes no second round trip.
  return (
    <Dialog
      open={open && cardId !== null}
      title="Legality"
      subtitle={card.data?.name}
      closeLabel="Close legality"
      size="w-[45rem]"
      onDismiss={close}
      onClose={close}
    >
      {/* two columns at `@[640px]`, one below — the mockup's `repeat(2,1fr)` / `repeat(1,1fr)` */}
    </Dialog>
  );
}
```

Statuses and their tokens: `legal`, `not_legal`, `banned`, `restricted`. Take the colours from
`STATUS_CLASS` in `CardDetailPane.tsx:127` — it already names them and they are the app's, not the
mockup's raw oklch. Format display names come from `FORMAT_ORDER` in `printings.ts:28`; a key in
the JSON that is not in `FORMAT_ORDER` is drawn last rather than dropped, because Scryfall adds
formats without asking.

**No footer.** The mockup's Game Changer and Canadian Highlander lines are out of scope — spec §3.1.

**This dialog draws at `LAYER.overlayStacked`.** `Dialog` takes `LAYER.overlay` itself, so pass the
rung the way the shell allows; if `Dialog` has no seam for it, report that rather than editing
`Dialog` — Task 1 owns that file and you would clobber it.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check** — swap the direct JSON read for `legalityChips`. The first test must fail on "Standard". Restore.

- [ ] **Step 6: Story** — a card with all four statuses present, named `Legality`. Follow `.storybook/CLAUDE.md`'s fake-seeding rules; do not seed `cards` or `sync_meta`.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 5: `OracleTagsDialog`

**Files:**
- Create: `src/features/card/OracleTagsDialog.tsx`, `.test.tsx`, `.stories.tsx`

**Interfaces:**
- Consumes: Task 1, Task 2. Data: `ipc.oracleTagsForCards(oracleIds: string[]) => Promise<CardTags[]>`.
- Produces: `export function OracleTagsDialog(): JSX.Element`

- [ ] **Step 1: Write the failing test**

Three states, and the empty one is the point — the oracle tag dataset is optional by construction
and a database that never fetched it must say so rather than draw an empty box.

```tsx
it("lists the card's oracle tags as pills", async () => {
  oracleTagsForCards.mockResolvedValue([{ oracleId: "o1", tags: ["removal", "burn"] }]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText("removal")).toBeInTheDocument();
  expect(screen.getByText("burn")).toBeInTheDocument();
});

it("says the taxonomy has never been fetched rather than drawing an empty box", async () => {
  // CLAUDE.md: a database that has never fetched oracle tags files by card type instead, and
  // that fallback is the floor rather than an error. An empty panel would read as "this card
  // has no tags", which is a different and wrong claim.
  oracleTagsForCards.mockResolvedValue([]);
  renderWithCard({ oracleId: "o1" });

  expect(await screen.findByText(/no oracle tags/i)).toBeInTheDocument();
});

it("does not ask for tags for a card with no oracle id", () => {
  renderWithCard({ oracleId: null });
  expect(oracleTagsForCards).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement** — `size="w-[38.75rem]"`, title `"Oracle tags"`, `subtitle` the card's name, `closeLabel="Close oracle tags"`. Query key must include the oracle id. Footer caption: "Oracle tags come from Scryfall's tagger, as of the last card-data sync." — the app's rule that data with an age says its age.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check** — make the empty case render the pill list anyway. Test 2 must fail. Restore.

- [ ] **Step 6: Story** — `Tagged` and `NeverFetched`.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 6: `CardTextDialog`

**Files:**
- Create: `src/features/card/CardTextDialog.tsx`, `.test.tsx`, `.stories.tsx`

**Interfaces:**
- Consumes: Task 1, Task 2.
- Produces: `export function CardTextDialog(): JSX.Element`

This is the spec's answer to the mockup dropping `Facts`. Its content is `Facts`' **minus the
prices**, which move to Task 7.

- [ ] **Step 1: Write the failing test**

```tsx
it("draws both faces of a double-faced card", async () => {
  // The mockup shows one picture and the pane's Flip button; the text popup shows both sides
  // at once, because a reader who opened "card text" is asking what the card does, and half
  // of a transforming card is not an answer.
  renderWithCard({
    layout: "transform",
    faces: [
      { name: "Delver of Secrets", typeLine: "Creature — Human Wizard", oracleText: "At the beginning of your upkeep…", manaCost: "{U}", artist: "A" },
      { name: "Insectile Aberration", typeLine: "Creature — Human Insect", oracleText: "Flying", manaCost: null, artist: "A" },
    ],
  });

  expect(await screen.findByText("Delver of Secrets")).toBeInTheDocument();
  expect(screen.getByText("Insectile Aberration")).toBeInTheDocument();
  expect(screen.getByText("Flying")).toBeInTheDocument();
});

it("falls back to the card's own text when it has no faces", async () => {
  renderWithCard({ layout: "normal", faces: [], typeLine: "Instant", oracleText: "Deal 3 damage." });

  expect(await screen.findByText("Instant")).toBeInTheDocument();
  expect(screen.getByText("Deal 3 damage.")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement**

`size="w-[38.75rem]"`, title `"Card text"`, `subtitle` the card's name.

**Lift the face-resolving logic out of `Facts`** (`CardDetailPane.tsx:1594`) rather than rewriting
it: the `card.faces.length === 0 ? [synthesised] : sides === 2 ? [one] : all` shape handles meld,
split, transform and adventure, and getting it wrong is silent. **One deliberate change**: this
popup shows *all* faces, not the one the pane's flip state selected, so drop the `face` index.

Render mana costs with `ManaText`, the rarity with `RarityGem` (`withLabel`), and P/T or loyalty
from the face. Oracle text keeps its line breaks — `whitespace-pre-line`.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check** — return only `faces[0]`. Test 1 must fail on "Insectile Aberration". Restore.

- [ ] **Step 6: Story** — `Normal` and `DoubleFaced`.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 7: `CardModalArt` — the left column

**Files:**
- Create: `src/features/card/CardModalArt.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: `CardDetail` from `@/lib/ipc`, `CardImage`, `RarityGem`, `finishTreatments`/`treatmentName` from `@/lib/treatment`, `formatPrice`/`pricesAsOf` from `@/lib/prices`.
- Produces:
  ```ts
  export function CardModalArt(props: {
    card: CardDetail;
    face: number;
    onFlip: () => void;
    marketplace: Marketplace;
    /** The deck row's finish, or null outside a deck — drives the foil toggle's label. */
    deckFinish: DeckFinish | null;
    onToggleFoil: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

The one that matters is the spec's §4 correction — **the mockup's hardcoded Nonfoil/Foil pair is wrong.**

```tsx
it("prices every finish the printing has, not just nonfoil and foil", () => {
  // The mockup draws exactly two cells. A card sold only as etched would price as "—" under a
  // literal reading while the app holds a number for it — issue #160's whole point, that
  // `finishes` says how shiny and `promoTypes` says which shiny.
  render(
    <CardModalArt
      card={cardWith({ finishes: JSON.stringify(["etched"]), finishPrices: { etched: 12.5 } })}
      {...rest}
    />,
  );

  expect(screen.getByText(/etched/i)).toBeInTheDocument();
  expect(screen.getByText("$12.50")).toBeInTheDocument();
  expect(screen.queryByText(/^nonfoil$/i)).not.toBeInTheDocument();
});

it("says how old the prices are and whose they are", () => {
  render(<CardModalArt card={cardWith({})} marketplace={TCGPLAYER} {...rest} />);
  // Spec §5: a price is never shown without saying how old it is — and, now that there is
  // more than one answer, whose.
  expect(screen.getByText(/tcgplayer/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement**

Contents, top to bottom: the card image in a rounded bordered box with a **chin** below it
(`RarityGem`, set code, `·`, collector number, set name pushed right with `ml-auto`); a two-button
row (`Set as foil` / `Flip card`); then the price cells.

- The image is `CardImage` — never an `<img>`. It owns the `mtgimg://` protocol, the web target's
  `imageUris` fallback, and the placeholder for a printing with no art.
- The foil button's label is `deckFinish !== null ? "Set as …" : "View as …"` — that split already
  exists at `CardDetailPane.tsx:1300` and the words are load-bearing: outside a deck the toggle
  changes a *picture*, not a stored finish.
- `Flip card` renders only when `faceCount(card.layout, card.faces.length) > 1`.
- Price cells: one per finish from `parseFinishes(card.finishes)`, labelled by
  `treatmentName(finishTreatments(card.promoTypes, f)) ?? FINISH_LABEL[f]`, value
  `formatPrice(card.finishPrices[f])` with `—` for null. Laid out as the mockup's bordered
  two-up grid, wrapping to more rows when there are more than two.
- Caption: `pricesAsOf(marketplace)`.
- Below `@[640px]/card` the image is full width; at and above it the column is fixed by the parent.

Scryfall's usage rules: the artist credit and the source line are **required** wherever art is
shown. They live in Task 10's footnotes, not here — do not duplicate them.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check** — hardcode the two cells as the mockup does. Test 1 must fail. Restore.

- [ ] **Step 6: Report.** Do not commit.

---

### Task 8: `CardModalControls` — the centre column

**Files:**
- Create: `src/features/card/CardModalControls.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: Task 2's `CardModalScope`. `QuantityStepper` from `@/components/QuantityStepper`, `Dropdown` from `@/components/Dropdown/Dropdown`.
- Produces:
  ```ts
  export function CardModalControls(props: {
    card: CardDetail;
    scope: CardModalScope;
    printingCount: number;
    onViewAllPrintings: () => void;
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

The per-view table from spec §7 is the contract:

```tsx
it("draws the deck controls only for a card opened out of a deck", () => {
  render(<CardModalControls scope={deckScope} {...rest} />);
  expect(screen.getByRole("button", { name: /deck category/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /tag/i })).toBeInTheDocument();
});

it("draws no stepper and no deck controls on the search page", () => {
  render(<CardModalControls scope={searchScope} {...rest} />);
  expect(screen.queryByRole("button", { name: /deck category/i })).not.toBeInTheDocument();
  expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
});

it("offers the printings modal with the count in its name", () => {
  const onViewAllPrintings = vi.fn();
  render(<CardModalControls printingCount={4} onViewAllPrintings={onViewAllPrintings} {...rest} />);

  // The count is in the accessible name rather than beside it: a label and its count in two
  // spans separated by a CSS `gap` compute to "View all printings4".
  fireEvent.click(screen.getByRole("button", { name: "View all printings (4)" }));
  expect(onViewAllPrintings).toHaveBeenCalledOnce();
});
```

That third test's comment is a real trap in this repo — a `gap` between two spans breaks the
accessible name. Put the count inside the same text node or give the button an `aria-label`.

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement**

Rows, in order: **Quantity** (only when `scope.quantity !== null`; its label is "In deck" /
"Owned" / "Wished" by that value), then **Printing** — a `Dropdown` of this card's printings beside
a `View all printings (N)` button — then **Deck category** and **Tag** side by side when
`scope.deckControls`.

At `@[900px]/card` and above, Quantity and Printing share one row (`auto 1fr`) and Category/Tag
share the next (`repeat(2,1fr)`); below that each is its own full-width row at 44px tall.

Use the existing `Dropdown` component, **not** a hand-rolled popup: it already handles the listbox
roles, the caret, and dismissal. The mockup draws a search field inside the category and tag
popups — `Dropdown` either supports that or it does not; if it does not, draw the plain list and
report it rather than growing a search box here.

**Do not wire the deck writes.** Category, tag and quantity call props; Task 10 connects them to
`useDeck`. This file must render without a deck in the tree, or its test cannot exist.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check** — make `deckControls` always true. Test 2 must fail. Restore.

- [ ] **Step 6: Report.** Do not commit.

---

### Task 9: `CardModalRail` — the options rail

**Files:**
- Create: `src/features/card/CardModalRail.tsx`, `.test.tsx`

**Interfaces:**
- Consumes: Task 2's `CardModalScope` and `openCardOverlay`.
- Produces:
  ```ts
  export interface RailAction { label: string; onSelect: () => void }
  export function CardModalRail(props: {
    card: CardDetail;
    scope: CardModalScope;
    /** Surface-specific entries, appended after the four common ones. */
    actions: readonly RailAction[];
    /** owned / wished / decks, and the deck line when there is one. */
    counts: { owned: number; wished: number; decks: number };
  }): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

```tsx
it("opens each overlay through the store's single writer", async () => {
  render(<CardModalRail {...rest} />);

  await userEvent.click(screen.getByRole("button", { name: "Legality" }));
  expect(useAppStore.getState().cardOverlay).toBe("legality");

  await userEvent.click(screen.getByRole("button", { name: "Oracle tags" }));
  expect(useAppStore.getState().cardOverlay).toBe("oracleTags");
});

it("hides the grimoire counts at the middle rung and shows them at the widest", () => {
  // Artboard 2c drops them; 1a keeps them. jsdom resolves no container query, so the fold is
  // asserted as a class rather than as a measurement — the class IS the behaviour here.
  render(<CardModalRail {...rest} />);
  const counts = screen.getByText(/in your grimoire/i).closest("div") as HTMLElement;
  expect(counts.classList.contains("hidden")).toBe(true);
  expect(counts.classList.contains("@[1200px]/card:flex")).toBe(true);
});
```

- [ ] **Step 2: Run it to verify it fails.**

- [ ] **Step 3: Implement**

An **Options** heading, then a list: `Legality`, `Oracle tags`, `Card text`, `Open on Scryfall ↗`,
then `...actions`. Each is a 44px full-width left-aligned button. The rail is a list rather than
fixed slots, so a surface contributing three entries and one contributing six draw the same
component.

Below, `In your grimoire`: owned / wished / decks, plus `4× in Burn · mainboard` when
`scope.deck !== null`. Hidden below `@[1200px]/card` per artboard 2c.

At `@[640px]/card` and below the rail is not a column at all — it joins the single-column stack.
Task 10 owns that placement; this component just draws a `flex flex-col` that works in both.

`Open on Scryfall ↗` opens the external URL through whatever this app already uses for an outbound
link — grep for an existing Scryfall link before inventing one. Never `window.open` raw in a Tauri
webview.

- [ ] **Step 4: Run it to verify it passes** — Expected: PASS, 2 tests.

- [ ] **Step 5: Mutation-check** — drop the `@[1200px]/card:flex` class. Test 2 must fail. Restore.

- [ ] **Step 6: Report.** Do not commit.

---

### Task 10: `CardDetailModal` — the host

**Files:**
- Create: `src/features/card/CardDetailModal.tsx`, `.test.tsx`, `.stories.tsx`

**Interfaces:**
- Consumes: Tasks 1–3 and 7–9, all by their exported names above.
- Produces: `export function CardDetailModal(): JSX.Element` — reads `selectedCardId`, mounted once.

This is the task that assembles everything. It is deliberately last and alone in its wave.

- [ ] **Step 1: Write the failing tests**

```tsx
it("names the panel after the card, and stacks the header below the fold", async () => {
  renderModal("c1");
  // `Dialog` sets aria-labelledby to its own heading, so the modal is addressed by the card
  // rather than by the words "Card details".
  expect(await screen.findByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();
});

it("hands the caret back to the opener when dismissed, and not when the scrim is pressed", async () => {
  // Two different functions, and the difference is the caret. Escape and the ✕ are the reader
  // saying "put me back"; a press on the scrim means they have already moved on, and pulling
  // focus to a tile they are no longer looking at is the app arguing with them.
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  renderModal("c1");
  await screen.findByRole("dialog");

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
});

it("hides the step chevrons when the walk holds no stop for the open card", async () => {
  // A card reached from a meld relation or a printing swap has no position in any list, and a
  // chevron that cannot say where it would go is worse than no chevron.
  useAppStore.setState({ cardWalk: { label: "Search results", stops: [] } });
  renderModal("c1");
  await screen.findByRole("dialog");

  expect(screen.queryByRole("button", { name: /previous/i })).not.toBeInTheDocument();
});
```

**Satisfy that third test with `flanks: undefined`, never by making a chevron vanish.** An earlier
draft of this plan claimed `StepChevron` returns null on a null stop. **It does not, and it must
not** — wave 2 checked. It renders the chevron `disabled`, and its own doc argues for that: both
chevrons are drawn whenever either is, one greyed, because the pair is positioned against the
panel's edges and a chevron that came and went would make the first step of a walk the moment a
second control appeared under the reader's pointer.

So the "no stop at all" case is a decision about the **pair**, and it is made where the pair
exists — exactly as `AllPrintingsDialog` already does it (`AllPrintingsDialog.tsx:404`):

```tsx
// No walk, no flanks — and `undefined` rather than a pair of nulls, because that is what tells
// `Dialog` not to reserve the flank columns at all.
const flanks: DialogFlanks | undefined =
  at === -1 ? undefined : { left: <StepChevron … />, right: <StepChevron … /> };
```

Copy that shape. Teaching one chevron to hide would delete the greyed end-of-walk state from the
printings modal too.

- [ ] **Step 2: Run them to verify they fail.**

- [ ] **Step 3: Implement**

```tsx
export function CardDetailModal() {
  const cardId = useAppStore((s) => s.selectedCardId);
  const scope = useCardModalScope();
  // ... card query on cardDetailKey(cardId, marketplace.id)
  return (
    <Dialog
      open={cardId !== null}
      container
      size="w-full h-full @[640px]/card:w-[47.75rem] @[640px]/card:h-[52.5rem] @[900px]/card:w-[66.25rem] @[900px]/card:h-[47.5rem] @[1200px]/card:w-[77.5rem] @[1200px]/card:h-[50rem]"
      title={<CardModalTitle cardId={cardId} />}
      closeLabel="Close card details"
      flanks={/* StepChevron pair, or undefined below @[900px] */}
      onDismiss={dismiss}
      onClose={close}
    >
      {/* grid + action row */}
    </Dialog>
  );
}
```

**The `size` string above is a problem you must solve, not copy.** A container query cannot size
the element that *declares* the container — `@container/card` is on the panel, so `@[640px]/card:`
inside it queries the panel's own width and is circular. Two ways out, and you must pick one and
say why in the file:

1. Put the size on the panel from a **viewport** query (`sm:` / `min-[900px]:` / `min-[1200px]:`),
   and keep the container query for everything *inside* the panel. The panel's width is a question
   about the window, which satisfies `src/lib/viewports.ts`'s test at that one site; the columns
   inside are a question about the panel.
2. Declare the container on a wrapper *outside* the panel.

(1) is almost certainly right and is what the spec's §2.3 argument already licenses for the scrim.
Take it unless you find something that forbids it.

Then:
- **Header** — the card's name, type line and mana cost. Below `@[640px]/card` the type line and
  mana stack under the name; above, they sit beside it. `Dialog`'s `title` is a `ReactNode`, which
  is what makes this legal.
- **Body grid** — `grid-cols-1` below `@[640px]`, `@[640px]/card:grid-cols-[18.75rem_1fr]`,
  `@[900px]/card:grid-cols-[20rem_1fr_max-content]`,
  `@[1200px]/card:grid-cols-[23.5rem_1fr_max-content]`. Each column `min-h-0 overflow-y-auto`.
  Below `@[640px]` there are no columns: one scroller, everything stacked, rail entries included.
- **Action row** — `Add to wishlist` · `Add to collection` · `Add to deck`, right-aligned, with a
  top border, outside the scrollers. Below `@[900px]` the chevrons sit in its left corner; at 2b
  the first two shorten to `Wishlist` / `Collection`. Below `@[640px]` only `Add to deck` remains,
  full width, and the other two move into the rail's list.
- **Footnotes** — `pricesAsOf` and **the Scryfall credit**: `Illustrated by {artist}. Card images ©
  Wizards of the Coast · Data © Scryfall`. Required wherever art is shown, and the artist is the
  one whose art is *on screen* — the melded face's, not the open card's, when a meld is showing.
  Lift `artistOf` from `CardDetailPane.tsx:1087` rather than rewriting it.
- **`onDismiss` vs `onClose`** — the split the second test pins. Reuse the `closeRef` pattern from
  the reverted `CardDetailDialog`: the body publishes its own `close` (which holds the stashed
  opener) upward through a ref, and `onDismiss` calls that while `onClose` just clears the card.
  The patch is saved at `scratchpad/search-only-modal.patch` if you want to read that shape — but
  **do not apply it**, it is the deleted search-only design.
- **`View all printings`** calls `openAllPrintings`, the store action that already exists.
- **Escape needs no code.** `Dialog` registers the `"inner"` rung on its open flag, and a nested
  overlay mounting later lands above it on `useDismissOnEscape`'s capture stack. Do not add a rung.

- [ ] **Step 4: Run them to verify they pass** — Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-check** — point `onDismiss` at the plain store clear. Test 2 must fail on
  `toHaveFocus`. Restore. This is the failure that shipped once and was found by driving the
  window, not by the suite — it is worth knowing your test catches it.

- [ ] **Step 6: Stories** — one per rung, so all four layouts are visible in the workbench:
  `Phone`, `Narrow`, `Desktop`, `Wide`. Set the frame width per story.

- [ ] **Step 7: Report.** Do not commit.

---

### Task 11: Wire it up and delete the dock

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/App.test.tsx`
- Modify: `src/features/decks/DeckEditor.tsx`
- Modify: `src/features/decks/DeckEditor.test.tsx`
- Delete: `src/features/card/CardDetailPane.tsx`, `.test.tsx`, `.stories.tsx`

Serial, and alone in its wave: it touches the two biggest files in the app.

- [ ] **Step 1: Mount the new surfaces**

In `App.tsx`, replace the docked `<AnimatePresence>` block and the `CardDetailPane` import with
`<CardDetailModal />`, and add `<LegalityDialog />`, `<OracleTagsDialog />` and `<CardTextDialog />`
beside the existing `<AllPrintingsDialog />` at line ~275.

**All four are siblings of the shell, never children of the modal's panel** — the panel is a
container-query context and would capture their `fixed` scrims. Put the reason in a comment at the
site; it is the same hazard `App.tsx` already documents in the other direction.

Delete `paneAsModal` and `inDeckEditor` — both existed to choose between shapes that no longer
differ.

- [ ] **Step 2: Delete the deck editor's overlay**

In `DeckEditor.tsx` remove `paneFrameRef`, `PANE_OVER_ATTR`, the `dockWidth` state and its
`ResizeObserver`, the dock effect that writes the frame's `top`/`height` (~1793–1795), and the
`sticky top-0 -mb-3 h-0` box and its contents (~3317–3352).

**`deskWidth` stays.** It reads as the pane's and is not: `wideHeader`, `settingsIcon`,
`tightHeader`, `roomForPanel` and `maxPanelWidth` all depend on it. Deleting it is the mistake this
step exists to prevent.

- [ ] **Step 3a: Hoist `cardDetailKey` before deleting anything**

Wave 2 left four copies of `["card", cardId, marketplace]` — one in the pane and one in each of the
three overlays, each having copied it rather than import from a file that was about to be deleted.
That was the right call at the time and is the wrong end state: **four spellings of one query key
means the day one of them drifts, that surface silently stops sharing the cache entry and pays its
own round trip**, with nothing going red.

Create `src/features/card/cardDetailKey.ts` exporting the one function, and point all four at it —
plus `CardDetailModal` from Task 10, which is a fifth. Do this *first*, so the deletion in step 3
cannot take a definition with it.

- [ ] **Step 3: Move what is left of the pane, then delete it**

`CardDetailPane.tsx` should now have nothing that is not already in Tasks 6–10. Check for
stragglers before deleting: `deckControlFor`, `SwapOffer`, `paneTarget`, `CardMenuRefusal`, the
swap flow, and the `report` live region. Anything still needed moves to `CardDetailModal.tsx` or
its own module — **do not leave the file alive as a shell of exports.**

- [ ] **Step 4: Update the two test files**

`App.test.tsx` — every `getByRole("complementary", { name: /card details/i })` becomes
`findByRole("dialog", { name: /<card name>/i })`. The card is now named by the card, not by a
category word. Closes become `await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())`,
because the panel outlives the flag by the length of its exit.

**Add one test the old suite could not have:** the Escape ladder with a nested overlay open over
the card modal.

```tsx
it("gives one Escape to each layer: overlay, card, view", async () => {
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Lightning Bolt" }));
  await screen.findByRole("dialog", { name: /lightning bolt/i });

  await userEvent.click(screen.getByRole("button", { name: "Legality" }));
  await screen.findByRole("dialog", { name: /legality/i });

  await userEvent.keyboard("{Escape}");
  // The overlay goes and the card stays — the nested dialog mounted later, so it is above the
  // card on `useDismissOnEscape`'s capture stack and takes the press.
  await waitFor(() => expect(screen.queryByRole("dialog", { name: /legality/i })).not.toBeInTheDocument());
  expect(screen.getByRole("dialog", { name: /lightning bolt/i })).toBeInTheDocument();

  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  expect(screen.getByRole("group", { name: "Search results" })).toBeInTheDocument();
});
```

`DeckEditor.test.tsx` — anything asserting `PANE_OVER_ATTR` or the docked frame's geometry goes.
Tests that assert a card *opens* stay, retargeted at the dialog role.

- [ ] **Step 5: Report.** Do not commit — the coordinator runs `npm run verify` and commits the wave.

---

## After fan-in (coordinator only)

- [ ] `npm run verify` — build, lint, Vitest, cargo test. Never two at once; concurrent runs fake ~18 Rust schema failures.
- [ ] `cargo fmt --check` and `cargo clippy` in `src-tauri/` — **`verify` runs neither**, and they are the only reds achievable with a fully green verify.
- [ ] Drive the real window over CDP and confirm all four rungs, per `docs/reference/live-ui-verification.md`. jsdom saw none of the layout; this is the only pass that does.
- [ ] Record the measured rung widths in a reference doc, not in a test.

## Self-Review Notes

Checked against the spec on 2026-09-03:

- **§1.1 deletions** → Task 11 steps 2–3, with the `deskWidth` trap called out.
- **§2.1 breakpoints** → Tasks 7–10; Task 10 step 3 flags the circular-container problem the spec's table does not, and forces a decision.
- **§2.2 containment** → Task 11 step 1 and Task 1's `container` prop doc.
- **§2.3 full-bleed** → Task 1.
- **§3 four overlays** → Tasks 4, 5, 6 (new) and Task 3 + Task 10 (printings, existing).
- **§3.1 no legality footer** → Task 4 step 3.
- **§3.2 card text** → Task 6.
- **§4 per-finish prices** → Task 7 step 1, the mutation check included.
- **§5.1 Escape** → Task 10 step 3 ("do not add a rung") and Task 11 step 4's ladder test.
- **§5.2 rung split** → Task 2.
- **§6 stepping** → Task 3 and Task 10.
- **§7 per-view** → Task 2's `cardModalScope`, consumed by Tasks 8 and 9.
- **§8 testing** → each task's own steps, plus the coordinator list above.
