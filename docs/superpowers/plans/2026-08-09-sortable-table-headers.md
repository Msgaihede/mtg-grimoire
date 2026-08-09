# Sortable Table Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the dropdown-under-header bug with one named layer scale, and give the search, collection and wishlist tables clickable multi-key sortable headers on top of a single shared `VirtualTable`.

**Architecture:** A `src/lib/layers.ts` vocabulary replaces every hard-coded `z-*` in `src/`, with a sweep test that keeps it the only place they live. A pure `src/lib/sort.ts` reducer owns the click/shift-click cycle. `src/components/table/VirtualTable.tsx` absorbs the three near-identical virtualised tables, taking columns as data. On the Rust side one new `sorting.rs` turns an ordered list of `SortTerm`s into an `ORDER BY` through a per-table whitelist of SQL literals, always ending in a unique tiebreak.

**Tech Stack:** React 19, TypeScript 6, Tailwind v4, `@tanstack/react-virtual`, `@tanstack/react-query`, Vitest + Testing Library, Rust + rusqlite (SQLite/FTS5), Tauri 2.11.

**Spec:** `docs/superpowers/specs/2026-08-09-sortable-table-headers-design.md`

## Global Constraints

- **Run `npm run verify` before every commit.** It is build + lint + Vitest + `cargo test`.
  A task may run a focused test between steps, but nothing is committed without it.
- Work happens in the worktree at `D:\Code\mtg-grimoire\.claude\worktrees\table-refac`, on
  branch `worktree-table-refac`. Never `cd` to the main checkout to edit.
- Commit messages use `feat:` / `fix:` / `refactor:` / `test:` / `docs:` and end with
  `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Dim text is `text-dim`, never `text-muted`.** `src/lib/tokens.test.ts` enforces it.
- **Every `transition-*` class needs `motion-reduce:transition-none` within 400 characters.**
  `src/lib/tokens.test.ts` enforces it.
- **Tailwind v4 scans source text for whole class names.** A class assembled by template
  interpolation — `` `has-[…]:${LAYER.raised}` `` — emits no CSS rule at all. Any
  variant-prefixed layer is its own entry in `LAYER`, written out whole.
- **No user text ever reaches the SQL parser.** Sort keys are matched against `&'static str`
  literals in a whitelist and dropped when unknown.
- **Every `ORDER BY` ends in the table's unique key** (`c.id`, `e.id`, `w.id`). The pagers use
  `OFFSET`; without a total order a tie can move a row between page 1 and page 2.
- **Nothing declares `REFERENCES cards(...)`** and no index is added to `cards` in this plan.
- Do not add dependencies. There are no Radix packages and no `src/components/ui`; popups in
  this app are hand-rolled and anchored, never portalled (the shipped CSP is
  `style-src 'self'`).

## File Structure

**Created**

| Path | Responsibility |
| --- | --- |
| `src/lib/layers.ts` | The app's entire z-index vocabulary, as whole Tailwind class strings. |
| `src/lib/layers.test.ts` | Pins the order, and sweeps `src/` for raw `z-*` outside the module. |
| `src/lib/sort.ts` | `SortDir`, `SortTerm`, `SortSpec`, the `applySort` reducer, `ariaSortOf`, `sortIndexOf`. |
| `src/lib/sort.test.ts` | The reducer's whole behaviour. |
| `src/components/table/VirtualTable.tsx` | The one virtualised table: scroller, sticky sortable header, rows. |
| `src/components/table/SortableHeader.tsx` | One column header — button, arrow, ordinal badge, `aria-sort`. |
| `src/components/table/VirtualTable.test.tsx` | Header semantics, sort callbacks, row wiring. |
| `src-tauri/src/sorting.rs` | `SortTerm`, `SortColumn`, `order_by`. Shared by all three lists. |

**Modified**

| Path | Change |
| --- | --- |
| `src/features/search/SearchPage.tsx` | Table view becomes columns + `VirtualTable`; sort wired. |
| `src/features/search/useCardSearch.ts` | `sort` state, in the query key and the payload. |
| `src/features/search/SetCombobox.tsx` | `z-20` → `LAYER.popup`. This is the reported bug. |
| `src/features/collection/CollectionTable.tsx` | Columns + `VirtualTable`. |
| `src/features/collection/useCollection.ts` | `sort` becomes a `SortSpec`. |
| `src/features/collection/CollectionFilterBar.tsx` | Select drives the spec; reads back or says `Custom…`. |
| `src/features/wishlist/WishlistPage.tsx` | Columns + `VirtualTable`; select as above. |
| `src/features/wishlist/useWishlist.ts` | `sort` becomes a `SortSpec`. |
| `src/features/search/CardGrid.tsx`, `src/features/collection/AddToCollection.tsx`, `src/features/decks/DecksPage.tsx`, `src/features/decks/ValidationPanel.tsx`, `src/features/decks/ZoneColumn.tsx`, `src/features/decks/DeckEditor.tsx`, `src/features/decks/DropIndicator.tsx`, `src/features/card/PrintingPreview.tsx`, `src/components/SyncProgress.tsx` | z-index → `LAYER`. |
| `src/lib/ipc.ts` | `sort?: SortSpec<…>` on all three queries; per-view key unions. |
| `src-tauri/src/search.rs`, `src-tauri/src/collection.rs`, `src-tauri/src/wishlist.rs` | Whitelists; `sort: Option<Vec<SortTerm>>`. |
| `src-tauri/src/lib.rs` | `mod sorting;` |
| `scripts/cdp.mjs` | `--shift` on `click`, `text` and `press`. |
| `CLAUDE.md` | The layering rule and the measured sort figures. |

---

## Task 1: The layer scale

Fixes the reported bug on its own. Nothing below depends on it except by convention.

**Files:**
- Create: `src/lib/layers.ts`, `src/lib/layers.test.ts`
- Modify: `src/features/search/SetCombobox.tsx:219`, `src/features/search/SearchPage.tsx:413,493`,
  `src/features/search/CardGrid.tsx:262`, `src/features/collection/AddToCollection.tsx:261`,
  `src/features/collection/CollectionTable.tsx:190`, `src/features/wishlist/WishlistPage.tsx:556`,
  `src/features/decks/DecksPage.tsx:512,670`, `src/features/decks/ValidationPanel.tsx:295`,
  `src/features/decks/ZoneColumn.tsx:723`, `src/features/decks/DeckEditor.tsx:884`,
  `src/features/decks/DropIndicator.tsx:43`, `src/features/card/PrintingPreview.tsx:341`,
  `src/components/SyncProgress.tsx:122`

**Interfaces:**
- Produces: `LAYER` — `{ raised, raisedWhenPopupOpen, header, popup, dragTray, gate }`, every
  value a whole Tailwind class string. Every later task imports it instead of writing `z-*`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/layers.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { LAYER } from "./layers";

/**
 * Every source file in the app, as text. The stylesheet is in the sweep for the reason
 * `tokens.test.ts` gives: Tailwind's scanner reads prose as eagerly as code, so a class
 * named in a comment is a class the build emits a rule for.
 */
const SOURCES = import.meta.glob<string>("/src/**/*.{ts,tsx,css}", {
  query: "?raw",
  import: "default",
  eager: true,
});

/** Any Tailwind z-index utility, with or without a variant prefix in front of it. */
const Z_CLASS = /\bz-(?:\d+|auto|\[[^\]]*\])\b/g;

const numberOf = (cls: string): number => Number(cls.match(/z-(\d+)/)![1]);

describe("the layer scale", () => {
  /**
   * The bug this scale exists for: the set picker and the tables' sticky headers were both
   * `z-20` in the root stacking context, and equal z-indexes are resolved by document
   * order — where every header comes after the filter bar it was drawn over.
   */
  it("puts a popup above a sticky header, and a lifted row below one", () => {
    expect(numberOf(LAYER.raised)).toBeLessThan(numberOf(LAYER.header));
    expect(numberOf(LAYER.header)).toBeLessThan(numberOf(LAYER.popup));
    expect(numberOf(LAYER.popup)).toBeLessThan(numberOf(LAYER.dragTray));
    expect(numberOf(LAYER.dragTray)).toBeLessThan(numberOf(LAYER.gate));
  });

  /**
   * The row lift is spelled as a `:has` variant, and Tailwind's scanner reads whole class
   * names out of source text — so a variant assembled by interpolation emits no rule at
   * all. It has to be written out, which is why it is its own entry.
   */
  it("spells the row lift out whole, at the raised layer", () => {
    expect(LAYER.raisedWhenPopupOpen).toBe(`has-[[aria-expanded=true]]:${LAYER.raised}`);
  });

  /**
   * A scale nothing is obliged to use is a comment. Written as a sweep rather than as a
   * review rule because the failure it prevents — an inline `z-20` losing to a header by
   * document order — is invisible in every test that does not paint.
   */
  it("is the only place in src/ that names a z-index", () => {
    // A glob that stops matching returns `{}`, and a sweep over nothing finds nothing.
    expect(Object.keys(SOURCES).length).toBeGreaterThan(20);

    const offenders: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      if (path.endsWith("/src/lib/layers.ts")) continue;
      // Tests name classes to assert on them, and asserting on one is not shipping it.
      if (path.includes(".test.")) continue;
      for (const match of source.matchAll(Z_CLASS)) {
        offenders.push(`${path}: ${match[0]}`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/lib/layers.test.ts
```

Expected: FAIL — `Failed to resolve import "./layers"`.

- [ ] **Step 3: Write the module**

Create `src/lib/layers.ts`:

```ts
/**
 * Every z-index this app uses, named for what the thing *is*.
 *
 * It exists because of a bug that no amount of reading either file would have shown: the
 * search view's set picker (`absolute z-20`) was painted over by the results table's sticky
 * header (`sticky top-0 z-20`). Neither is inside the other, and nothing between them —
 * not the section, not the filter row, not the combobox's `relative` root, not the
 * scroller — creates a stacking context. So both land in the root one at the same number,
 * and **equal z-indexes are resolved by document order**. Every table header comes after
 * the filter bar. The header won.
 *
 * ## The part that is not the number
 *
 * **A z-index only competes inside its own stacking context.** The quick-add popup opened
 * inside a table row is capped by that row's {@link LAYER.raised} whatever it asks for,
 * because the row is `position: absolute` *and* `transform`ed and is therefore a stacking
 * context of its own. That is why {@link LAYER.raisedWhenPopupOpen} exists at all, and why
 * `raised` must stay **below** `header`: a row scrolling past the header has to go under
 * it. Raising a clipped popup's number is the fix that will not work; moving it out of the
 * transformed ancestor, or lifting that ancestor, is the fix that does.
 *
 * ## Why the values are whole strings
 *
 * Tailwind v4 scans source *text* for whole class names. A variant assembled by
 * interpolation — `` `has-[…]:${LAYER.raised}` `` — matches nothing the scanner knows and
 * emits no rule, which fails silently and only in a build. So every variant spelling is its
 * own entry here, written out.
 */
export const LAYER = {
  /**
   * Lifted above its siblings and still under a sticky header: a virtualised row holding an
   * open popup, and the deck editor's drop indicator.
   */
  raised: "z-10",
  /**
   * The row lift, as the tables spell it — a row comes forward only while something inside
   * it is expanded. Written out whole; see the note above.
   */
  raisedWhenPopupOpen: "has-[[aria-expanded=true]]:z-10",
  /** A table's sticky header row, over the rows scrolling under it. */
  header: "z-20",
  /** Anchored to a control and floating over the page: pickers, quick-adds, menus, previews. */
  popup: "z-30",
  /**
   * The deck editor's remove tray, which appears only during a drag. Above `popup` on
   * purpose: a drag can start while a menu is open, and the tray is the drop target the
   * pointer is being carried to.
   */
  dragTray: "z-40",
  /** `SyncProgress`'s full-window takeover, over everything. */
  gate: "z-50",
} as const;
```

- [ ] **Step 4: Move every z-index onto it**

In each file below, import `LAYER` from `@/lib/layers` and replace the literal. The classes
live inside `cn(...)` calls or plain `className` strings; where a `className` is a plain
string with a `z-*` in the middle, convert it to `cn("…", LAYER.x, "…")`.

| File:line | Was | Becomes |
| --- | --- | --- |
| `src/features/search/SetCombobox.tsx:219` | `absolute z-20 mt-1 w-72 …` | `cn("absolute mt-1 w-72 …", LAYER.popup)` |
| `src/features/search/SearchPage.tsx:413` | `"sticky top-0 z-20 border-b …"` | `"sticky top-0 border-b …", LAYER.header` |
| `src/features/search/SearchPage.tsx:493` | `"has-[[aria-expanded=true]]:z-10"` | `LAYER.raisedWhenPopupOpen` |
| `src/features/search/CardGrid.tsx:262` | `"absolute inset-x-0 top-0 flex gap-3 has-[[aria-expanded=true]]:z-10"` | `cn("absolute inset-x-0 top-0 flex gap-3", LAYER.raisedWhenPopupOpen)` |
| `src/features/collection/AddToCollection.tsx:261` | `"absolute top-7 z-20 w-64 …"` | `"absolute top-7 w-64 …", LAYER.popup` |
| `src/features/collection/CollectionTable.tsx:190` | `"sticky top-0 z-20 border-b …"` | `"sticky top-0 border-b …", LAYER.header` |
| `src/features/wishlist/WishlistPage.tsx:556` | `"sticky top-0 z-20 border-b …"` | `"sticky top-0 border-b …", LAYER.header` |
| `src/features/decks/DecksPage.tsx:512` | `"absolute inset-x-0 top-8 z-20 …"` | `"absolute inset-x-0 top-8 …", LAYER.popup` |
| `src/features/decks/DecksPage.tsx:670` | `"absolute left-0 top-11 z-20 w-72 …"` | `"absolute left-0 top-11 w-72 …", LAYER.popup` |
| `src/features/decks/ValidationPanel.tsx:295` | `"absolute left-0 top-11 z-20 w-80 …"` | `"absolute left-0 top-11 w-80 …", LAYER.popup` |
| `src/features/decks/ZoneColumn.tsx:723` | `"absolute right-1 z-20 w-44 …"` | `"absolute right-1 w-44 …", LAYER.popup` |
| `src/features/decks/DeckEditor.tsx:884` | `"absolute inset-x-0 bottom-0 -top-3 z-30 …"` | `"absolute inset-x-0 bottom-0 -top-3 …", LAYER.dragTray` |
| `src/features/decks/DropIndicator.tsx:43` | `"pointer-events-none absolute inset-x-0 top-0 z-10 h-0.5 bg-accent"` | `cn("pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-accent", LAYER.raised)` |
| `src/features/card/PrintingPreview.tsx:341` | `"pointer-events-none absolute z-20 overflow-hidden …"` | `cn("pointer-events-none absolute overflow-hidden …", LAYER.popup)` |
| `src/components/SyncProgress.tsx:122` | `"fixed inset-0 z-50 flex flex-col …"` | `cn("fixed inset-0 flex flex-col …", LAYER.gate)` |

- [ ] **Step 5: Run the sweep and the two suites that assert on these classes**

```bash
npx vitest run src/lib/layers.test.ts src/features/search/SearchPage.test.tsx src/features/search/CardGrid.test.tsx
```

Expected: PASS. `SearchPage.test.tsx:554` and `CardGrid.test.tsx:301` assert the literal
string `has-[[aria-expanded=true]]:z-10`, which `LAYER.raisedWhenPopupOpen` still is.
`SearchPage.test.tsx:556` asserts `"sticky"`, `"z-20"` on the header, which `LAYER.header`
still is. If either fails, the class string changed and that is the bug, not the test.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/lib/layers.ts src/lib/layers.test.ts src/features src/components
git commit -m "fix(ui): stop a table header painting over an open dropdown

The set picker and the three tables' sticky headers were both z-20 in the
root stacking context — nothing between them creates one — and equal
z-indexes are resolved by document order, where every header comes after
the filter bar. One named scale, a sweep test that keeps it the only place
z-indexes live, and the note that a number cannot lift a popup out of a
transformed ancestor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: The sort model

Pure TypeScript. No UI, no network.

**Files:**
- Create: `src/lib/sort.ts`, `src/lib/sort.test.ts`

**Interfaces:**
- Produces:
  - `type SortDir = "asc" | "desc"`
  - `interface SortTerm<K extends string = string> { readonly key: K; readonly dir: SortDir }`
  - `type SortSpec<K extends string = string> = readonly SortTerm<K>[]`
  - `applySort<K extends string>(spec: SortSpec<K>, key: K, opts: { additive: boolean; firstDir: SortDir }): SortSpec<K>`
  - `sortTermOf<K extends string>(spec: SortSpec<K>, key: K): SortTerm<K> | undefined`
  - `sortRankOf<K extends string>(spec: SortSpec<K>, key: K): number | null` — 1-based, `null` when absent
  - `ariaSortOf(term: SortTerm | undefined): "ascending" | "descending" | "none"`

- [ ] **Step 1: Write the failing test**

Create `src/lib/sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { applySort, ariaSortOf, sortRankOf, sortTermOf, type SortSpec } from "./sort";

const asc = { additive: false, firstDir: "asc" } as const;
const desc = { additive: false, firstDir: "desc" } as const;
const addAsc = { additive: true, firstDir: "asc" } as const;

describe("applySort", () => {
  it("starts a column in the direction that column asks for first", () => {
    expect(applySort([], "name", asc)).toEqual([{ key: "name", dir: "asc" }]);
    // Money and count columns open descending: "highest first" is what clicking one means.
    expect(applySort([], "price", desc)).toEqual([{ key: "price", dir: "desc" }]);
  });

  it("cycles a lone column through both directions and then off", () => {
    const one = applySort([], "name", asc);
    const two = applySort(one, "name", asc);
    expect(two).toEqual([{ key: "name", dir: "desc" }]);
    // Off, not back to ascending: the third press has to be able to mean "never mind",
    // or a reader who sorted by accident has no way back to the view's own order.
    expect(applySort(two, "name", asc)).toEqual([]);
  });

  it("replaces the whole sort when a plain click lands on another column", () => {
    const spec: SortSpec = [
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ];
    expect(applySort(spec, "rarity", asc)).toEqual([{ key: "rarity", dir: "asc" }]);
  });

  it("appends with shift, keeping the terms already there and their order", () => {
    const spec = applySort([], "rarity", asc);
    expect(applySort(spec, "price", { additive: true, firstDir: "desc" })).toEqual([
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
  });

  it("cycles a shifted column in place, and removes only that one", () => {
    const spec: SortSpec = [
      { key: "rarity", dir: "asc" },
      { key: "price", dir: "desc" },
    ];
    const flipped = applySort(spec, "rarity", addAsc);
    // In place: a column that jumped to the end of the sort when you changed its direction
    // would silently re-order the other keys.
    expect(flipped).toEqual([
      { key: "rarity", dir: "desc" },
      { key: "price", dir: "desc" },
    ]);
    expect(applySort(flipped, "rarity", addAsc)).toEqual([{ key: "price", dir: "desc" }]);
  });

  it("treats a shift-click on the only remaining column exactly like a plain one", () => {
    const spec = applySort([], "name", asc);
    expect(applySort(spec, "name", addAsc)).toEqual([{ key: "name", dir: "desc" }]);
  });

  it("never mutates the spec it was given", () => {
    const spec: SortSpec = [{ key: "name", dir: "asc" }];
    applySort(spec, "price", { additive: true, firstDir: "desc" });
    expect(spec).toEqual([{ key: "name", dir: "asc" }]);
  });
});

describe("reading a spec", () => {
  const spec: SortSpec = [
    { key: "rarity", dir: "asc" },
    { key: "price", dir: "desc" },
  ];

  it("finds a term and its 1-based rank", () => {
    expect(sortTermOf(spec, "price")).toEqual({ key: "price", dir: "desc" });
    expect(sortRankOf(spec, "rarity")).toBe(1);
    expect(sortRankOf(spec, "price")).toBe(2);
    expect(sortRankOf(spec, "name")).toBeNull();
  });

  it("says none for a column nothing sorts by", () => {
    expect(ariaSortOf(sortTermOf(spec, "rarity"))).toBe("ascending");
    expect(ariaSortOf(sortTermOf(spec, "price"))).toBe("descending");
    expect(ariaSortOf(sortTermOf(spec, "name"))).toBe("none");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/lib/sort.test.ts
```

Expected: FAIL — `Failed to resolve import "./sort"`.

- [ ] **Step 3: Write the module**

Create `src/lib/sort.ts`:

```ts
/**
 * What "sorted by" means everywhere in this app: an ordered list of columns, each with a
 * direction, the first one deciding and the rest breaking its ties.
 *
 * A list rather than one key, because comparing printings is what these tables are for and
 * the question is usually two-part — cheapest *within* each rarity, newest *within* each
 * set. One key answers half of it and leaves the other half to whatever order the database
 * happened to produce.
 *
 * The empty spec is a real state and is not the same as "unsorted": it means the view's own
 * default, which for the search is relevance when there is a query and name when there is
 * not, and for the two lists is name. Nothing in this app is ever unsorted.
 */
export type SortDir = "asc" | "desc";

export interface SortTerm<K extends string = string> {
  readonly key: K;
  readonly dir: SortDir;
}

export type SortSpec<K extends string = string> = readonly SortTerm<K>[];

/** The term for one column, or nothing when the sort does not mention it. */
export function sortTermOf<K extends string>(
  spec: SortSpec<K>,
  key: K,
): SortTerm<K> | undefined {
  return spec.find((t) => t.key === key);
}

/**
 * Where a column sits in the sort, counting from 1 — the number drawn beside its arrow
 * once there is more than one. `null` when the sort does not mention it.
 */
export function sortRankOf<K extends string>(spec: SortSpec<K>, key: K): number | null {
  const at = spec.findIndex((t) => t.key === key);
  return at < 0 ? null : at + 1;
}

/** A term as `aria-sort` spells it. */
export function ariaSortOf(term: SortTerm | undefined): "ascending" | "descending" | "none" {
  if (!term) return "none";
  return term.dir === "asc" ? "ascending" : "descending";
}

/** The direction after this one, in the cycle below. */
const flip = (dir: SortDir): SortDir => (dir === "asc" ? "desc" : "asc");

/**
 * One press on a column header, answered.
 *
 * Every column cycles the same way — `firstDir`, then the opposite, then gone — and the
 * modifier decides only what happens to the *other* columns: a plain press replaces the
 * sort, a shifted one edits this column and leaves the rest alone. So a reader who has
 * never held Shift can still reach every single-column order, and one who has can build a
 * two- or three-key sort without learning a second gesture.
 *
 * A cycled-out column is *removed* rather than reset, which is what makes the third press
 * mean "never mind" — without it, a reader who sorted by accident has no way back to the
 * view's own order.
 *
 * No cap on the number of terms. The sortable columns are the cap, and they number five.
 *
 * @param firstDir which direction one press asks for first — ascending on names and text,
 *        descending on money and counts, because "highest first" is what clicking a price
 *        column means.
 */
export function applySort<K extends string>(
  spec: SortSpec<K>,
  key: K,
  { additive, firstDir }: { additive: boolean; firstDir: SortDir },
): SortSpec<K> {
  const current = sortTermOf(spec, key);

  if (!additive) {
    // Not in the sort, or in it alongside others: this press is the whole new sort.
    if (!current || spec.length > 1) return [{ key, dir: firstDir }];
    return current.dir === firstDir ? [{ key, dir: flip(firstDir) }] : [];
  }

  if (!current) return [...spec, { key, dir: firstDir }];
  // Rewritten in place rather than removed and re-appended: a column that jumped to the end
  // of the sort when its direction changed would silently re-order the other keys.
  if (current.dir === firstDir) {
    return spec.map((t) => (t.key === key ? { key, dir: flip(firstDir) } : t));
  }
  return spec.filter((t) => t.key !== key);
}
```

- [ ] **Step 4: Run the test**

```bash
npx vitest run src/lib/sort.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src/lib/sort.ts src/lib/sort.test.ts
git commit -m "feat(sort): the sort spec every table header will drive

An ordered list of columns with directions, and one reducer for a press.
Plain and shifted presses cycle a column identically; the modifier decides
only what happens to the other columns, so every single-column order is
reachable without ever holding Shift.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: `sorting.rs` — one `ORDER BY` builder

Pure Rust. Wired into nothing yet.

**Files:**
- Create: `src-tauri/src/sorting.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod sorting;` beside the other `mod` lines)

**Interfaces:**
- Produces:
  - `pub struct SortTerm { pub key: String, pub dir: String }` — `#[serde(rename_all = "camelCase")]`, `Deserialize`
  - `pub struct SortColumn { pub key: &'static str, pub asc: &'static str, pub desc: &'static str }`
  - `pub fn order_by(terms: Option<&[SortTerm]>, allowed: &[SortColumn], fallback: &str, tiebreak: &str) -> String`

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/sorting.rs` containing **only** the test module below, so the test
compiles against nothing and fails:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const COLUMNS: &[SortColumn] = &[
        SortColumn {
            key: "name",
            asc: "c.name ASC",
            desc: "c.name DESC",
        },
        SortColumn {
            key: "price",
            asc: "c.price_usd ASC NULLS LAST",
            desc: "c.price_usd DESC NULLS LAST",
        },
    ];

    const FALLBACK: &str = "c.name ASC";
    const TIEBREAK: &str = "c.id ASC";

    fn term(key: &str, dir: &str) -> SortTerm {
        SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }

    #[test]
    fn no_terms_is_the_view_default() {
        assert_eq!(order_by(None, COLUMNS, FALLBACK, TIEBREAK), "c.name ASC, c.id ASC");
        assert_eq!(order_by(Some(&[]), COLUMNS, FALLBACK, TIEBREAK), "c.name ASC, c.id ASC");
    }

    #[test]
    fn terms_are_joined_in_the_order_they_arrive() {
        let terms = [term("price", "desc"), term("name", "asc")];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC"
        );
    }

    /// The whole safety property in one test: a key is a lookup, never a fragment. The
    /// frontend cannot reach the parser, and a request built by hand cannot either.
    #[test]
    fn an_unknown_key_is_dropped_rather_than_interpolated() {
        let terms = [term("c.name; DROP TABLE cards", "asc"), term("released_at", "desc")];
        let sql = order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK);
        assert_eq!(sql, "c.name ASC, c.id ASC");
        assert!(!sql.contains("DROP"));
    }

    /// Same reason: a direction is two literals, so anything else is `asc` and not a clause.
    #[test]
    fn an_unknown_direction_is_ascending() {
        let terms = [term("name", "descending; --")];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.id ASC"
        );
    }

    /// A UI cannot produce this, and a duplicate key in an `ORDER BY` is dead SQL whose
    /// second copy would be read by a human as the one that won.
    #[test]
    fn a_repeated_key_keeps_only_its_first_appearance() {
        let terms = [term("name", "asc"), term("price", "desc"), term("name", "desc")];
        assert_eq!(
            order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK),
            "c.name ASC, c.price_usd DESC NULLS LAST, c.id ASC"
        );
    }

    /// Paging is `OFFSET`-based, so a sort that is not a total order shows one row twice
    /// and another never. The tiebreak is not the caller's to forget.
    #[test]
    fn the_tiebreak_is_always_last() {
        let terms = [term("name", "asc")];
        assert!(order_by(Some(&terms), COLUMNS, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
        assert!(order_by(None, COLUMNS, FALLBACK, TIEBREAK).ends_with("c.id ASC"));
    }
}
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd src-tauri && cargo test sorting
```

Expected: FAIL to compile — `cannot find type SortColumn in this scope`. (Add
`mod sorting;` to `src-tauri/src/lib.rs` first if the module is not picked up at all.)

- [ ] **Step 3: Write the module above the test**

Put this at the top of `src-tauri/src/sorting.rs`:

```rust
//! One `ORDER BY` builder, shared by the search, the collection and the wishlist.
//!
//! A sort arrives from the UI as an ordered list of `{key, dir}`. Nothing in it is ever
//! interpolated: a key is looked up in the calling table's whitelist of `&'static str`
//! literals and dropped when it misses, and a direction picks one of two literals. So the
//! only thing a request can influence is *which* of a fixed set of clauses is used and in
//! what order — which is the same property `search.rs` has always had for its four
//! hard-coded orders, kept while the number of reachable orders goes from four to dozens.

use serde::Deserialize;

/// One term of a sort, as the UI sends it.
///
/// `dir` is a string rather than an enum because a bad value must be a *default*, not a
/// deserialization failure: a list that refuses to load is a worse answer to a typo in a
/// payload than a list in ascending order.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortTerm {
    pub key: String,
    pub dir: String,
}

/// A column a table will sort on: the key the UI sends, and the SQL for each direction.
///
/// Both directions are written out rather than one clause plus an appended `DESC`, because
/// half of them are not one column — `set` is three, and every nullable column states its
/// null rule in both directions rather than inheriting SQLite's (NULLs first ascending,
/// last descending, which reads as a different sort rather than as the same one reversed).
pub struct SortColumn {
    pub key: &'static str,
    pub asc: &'static str,
    pub desc: &'static str,
}

/// Build an `ORDER BY` body — no `ORDER BY` keyword, just the list.
///
/// `fallback` is what an empty or wholly unrecognised sort means, which is the view's own
/// order rather than nothing. `tiebreak` is the table's unique key and is always appended:
/// the pagers use `OFFSET`, and two rows tying on every stated key can otherwise swap
/// places between the request for page 1 and the request for page 2 — showing the reader
/// one of them twice and the other never.
pub fn order_by(
    terms: Option<&[SortTerm]>,
    allowed: &[SortColumn],
    fallback: &str,
    tiebreak: &str,
) -> String {
    let mut parts: Vec<&'static str> = Vec::new();
    let mut used: Vec<&'static str> = Vec::new();

    for term in terms.unwrap_or(&[]) {
        let Some(column) = allowed.iter().find(|c| c.key == term.key) else {
            continue;
        };
        // A repeated key is dead SQL whose second copy reads, to a human, like the one that
        // won. First appearance is the one the reader built first.
        if used.contains(&column.key) {
            continue;
        }
        used.push(column.key);
        // Anything that is not "desc" is ascending, for the reason `SortTerm::dir` gives.
        parts.push(if term.dir == "desc" { column.desc } else { column.asc });
    }

    if parts.is_empty() {
        return format!("{fallback}, {tiebreak}");
    }
    format!("{}, {tiebreak}", parts.join(", "))
}
```

Add `mod sorting;` to `src-tauri/src/lib.rs` beside the other module declarations.

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test sorting
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Verify and commit**

```bash
npm run verify
git add src-tauri/src/sorting.rs src-tauri/src/lib.rs
git commit -m "feat(sort): one ORDER BY builder for all three lists

A key is a lookup in a whitelist of literals, never a fragment, and the
table's unique key is appended by the builder rather than by each caller —
OFFSET paging over a sort that is not a total order shows one row twice
and another never.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: The search backend takes a sort spec — and the measurement

**Files:**
- Modify: `src-tauri/src/search.rs:66-68` (the field), `:174` (`ORDER_NAME`), `:252-262`
  (the `match`), `:291-301` (the page SQL, if the measurement says so)
- Create: `scratch/measure-sort.mjs` — **not committed**, written under the scratchpad
  directory, not the repo

**Interfaces:**
- Consumes: `sorting::{order_by, SortColumn, SortTerm}` from Task 3.
- Produces: `SearchRequest.sort: Option<Vec<SortTerm>>`; the whitelist keys
  `name` | `set` | `type` | `rarity` | `price`, which Task 6's columns must match exactly.

- [ ] **Step 1: Measure what an unindexed sort costs, before writing any of it**

`cards` is indexed on `name`, `oracle_id` and `(set_code, collector_number)` only. SQLite
computes the SELECT list before the sorter unless an index supplies the order, and the page
query's SELECT list carries two correlated subqueries. Under an unindexed sort those run
once per *matching* row — 116 590 times on the unfiltered browse — rather than once per row
returned.

Write this to the scratchpad (**not** the repo) and run it. It opens the main checkout's
real database read-only; the app may be running, WAL allows it.

```js
// C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire\<session>\scratchpad\measure-sort.mjs
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("D:/Code/mtg-grimoire/src-tauri/target/debug/data/mtg.db", {
  readOnly: true,
});

const STATUS = `
  coalesce((SELECT sum(e.quantity) FROM collection_entries e WHERE e.card_id = c.id), 0) AS owned,
  EXISTS (SELECT 1 FROM wishlist_entries w
           WHERE w.card_id = c.id
              OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL AND w.oracle_id = c.oracle_id)) AS wished`;

const WHERE = "c.is_paper = 1";

const flat = (order) => `
  SELECT c.id, c.name, c.set_code, c.collector_number, c.rarity, c.type_line,
         c.price_usd, ${STATUS}
    FROM cards c WHERE ${WHERE} ORDER BY ${order} LIMIT 50 OFFSET 0`;

const twoStep = (order) => `
  SELECT c.id, c.name, c.set_code, c.collector_number, c.rarity, c.type_line,
         c.price_usd, ${STATUS}
    FROM (SELECT c.id AS pid FROM cards c WHERE ${WHERE} ORDER BY ${order} LIMIT 50 OFFSET 0) p
    JOIN cards c ON c.id = p.pid`;

const ORDERS = {
  "name (indexed)": "c.name ASC, c.id ASC",
  price: "c.price_usd DESC NULLS LAST, c.name ASC, c.id ASC",
  rarity:
    "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 " +
    "WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END ASC, " +
    "c.name ASC, c.id ASC",
  "rarity+price":
    "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 " +
    "WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END ASC, " +
    "c.price_usd DESC NULLS LAST, c.id ASC",
};

const median = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const time = (sql) => {
  const stmt = db.prepare(sql);
  stmt.all(); // warm
  return median(
    Array.from({ length: 5 }, () => {
      const t = process.hrtime.bigint();
      stmt.all();
      return Number(process.hrtime.bigint() - t) / 1e6;
    }),
  );
};

console.log("order".padEnd(16), "flat".padStart(9), "two-step".padStart(9));
for (const [label, order] of Object.entries(ORDERS)) {
  console.log(
    label.padEnd(16),
    `${time(flat(order)).toFixed(1)} ms`.padStart(9),
    `${time(twoStep(order)).toFixed(1)} ms`.padStart(9),
  );
}
db.close();
```

```bash
node "C:\Users\Markus\AppData\Local\Temp\claude\D--Code-mtg-grimoire\<session>\scratchpad\measure-sort.mjs"
```

**Write the numbers down.** They go in the commit message, in `CLAUDE.md` (Task 9) and in
the decision below.

- [ ] **Step 2: Decide the page query's shape from the numbers**

- If the flat form's unindexed sorts are within ~50 ms of the indexed `name` sort, **keep
  the flat query**. Skip Step 6.
- Otherwise adopt the two-step form in Step 6: order and limit a lean inner query to 50
  ids, then fetch the columns for those. Do **not** add an index to `cards` either way — a
  multi-term sort cannot use one past its leading column, and `schema::swap_staging` drops
  and replays every index on `cards` on each of the ~93 s syncs.

- [ ] **Step 3: Write the failing tests**

Add to `src-tauri/src/search.rs`'s existing `mod tests`. Follow the fixture helpers already
there (the module builds an in-memory database with `schema::migrate` and inserts cards; use
whatever `fn seed`/`fn card` helper the existing tests use rather than inventing one).

```rust
    /// A rarity is a rank, not a word: alphabetically `mythic` sits between `common` and
    /// `rare`, which is an order describing nothing anybody wants.
    #[test]
    fn rarity_sorts_by_rank_and_not_alphabetically() {
        let conn = fixture_with_rarities(&["mythic", "common", "rare", "uncommon"]);
        let req = SearchRequest {
            sort: Some(vec![term("rarity", "asc")]),
            ..Default::default()
        };
        let got: Vec<String> = run_search(&conn, &req)
            .unwrap()
            .items
            .iter()
            .map(|c| c.rarity.clone().unwrap())
            .collect();
        assert_eq!(got, ["common", "uncommon", "rare", "mythic"]);
    }

    /// The second key is what a two-column sort is *for*: within one rarity, by price.
    #[test]
    fn a_second_term_breaks_the_first_ones_ties() {
        let conn = fixture_with_priced_rarities(&[
            ("a", "rare", 1.0),
            ("b", "rare", 9.0),
            ("c", "common", 5.0),
        ]);
        let req = SearchRequest {
            sort: Some(vec![term("rarity", "asc"), term("price", "desc")]),
            ..Default::default()
        };
        let got: Vec<String> = run_search(&conn, &req)
            .unwrap()
            .items
            .iter()
            .map(|c| c.name.clone())
            .collect();
        assert_eq!(got, ["c", "b", "a"]);
    }

    /// Two pages of a two-key sort must not overlap and must not skip. The tiebreak is
    /// what makes that true, and this is the test that would catch its removal.
    #[test]
    fn a_two_key_sort_pages_without_repeating_a_row() {
        let conn = fixture_with_many_ties();
        let page = |offset: u32| -> Vec<String> {
            run_search(
                &conn,
                &SearchRequest {
                    sort: Some(vec![term("rarity", "asc"), term("price", "desc")]),
                    limit: 5,
                    offset,
                    ..Default::default()
                },
            )
            .unwrap()
            .items
            .iter()
            .map(|c| c.id.clone())
            .collect()
        };
        let mut all = page(0);
        all.extend(page(5));
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len(), "a row appeared on both pages");
    }

    /// The frontend cannot send this. A hand-built payload can, and it must be a sort that
    /// does nothing rather than a statement.
    #[test]
    fn an_injected_sort_key_is_dropped() {
        let conn = fixture_with_rarities(&["rare", "common"]);
        let req = SearchRequest {
            sort: Some(vec![term("c.name; DROP TABLE cards", "asc")]),
            ..Default::default()
        };
        // Answers, and answers in the default order.
        assert!(run_search(&conn, &req).is_ok());
        assert!(run_search(&conn, &SearchRequest::default()).is_ok());
    }
```

Add the helper beside them:

```rust
    fn term(key: &str, dir: &str) -> crate::sorting::SortTerm {
        crate::sorting::SortTerm {
            key: key.to_owned(),
            dir: dir.to_owned(),
        }
    }
```

Write `fixture_with_rarities`, `fixture_with_priced_rarities` and `fixture_with_many_ties`
using the module's existing fixture builder. `fixture_with_many_ties` inserts 10 cards that
all share one rarity and one price, so every row ties on both stated keys and only the
tiebreak separates them.

Update every existing test in `search.rs` that sets `sort: Some("name".into())` (and
`"released"`, `"price"`) to the new shape, `sort: Some(vec![term("name", "asc")])`. The
`"released"` key is **removed** — see Step 4 — so any test asserting it now asserts the
default order instead, or is deleted if that is all it asserted.

- [ ] **Step 4: Run them and watch them fail**

```bash
cd src-tauri && cargo test search
```

Expected: FAIL to compile — `expected Option<String>, found Option<Vec<SortTerm>>`.

- [ ] **Step 5: Change the field, the whitelist and the `match`**

In `src-tauri/src/search.rs`, replace the `sort` field (`:66-68`):

```rust
    /// How to order the page: a list of columns, first one deciding, the rest breaking its
    /// ties. Empty or absent is the default — relevance when `text` is set, name order when
    /// it is not. Keys outside [`SEARCH_SORTS`] are dropped, never interpolated.
    pub sort: Option<Vec<crate::sorting::SortTerm>>,
```

Add above `run_search`, beside `ORDER_NAME`:

```rust
/// Rarity as a rank. Alphabetically `mythic` sits between `common` and `rare`, which is an
/// order describing nothing anybody wants. `special` and `bonus` are real values with no
/// place in the printed hierarchy and sort after it; anything unknown sorts last.
const RARITY_RANK: &str = "CASE c.rarity \
     WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 \
     WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END";

/// The columns the search table's headers can sort on, and nothing else.
///
/// `set` is the binder order — set code, then *natural* collector number, which is a `CAST`
/// because ~9% of collector numbers are not numeric (`741z`, `1★`, `A-123`) and a plain
/// string sort puts `100` before `2`. The same expression the collection has used since it
/// grew a set order.
///
/// Every nullable column states its null rule in both directions rather than inheriting
/// SQLite's (NULLs first ascending, last descending): a reader reversing a sort expects the
/// rows reversed, not the holes moved.
const SEARCH_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "c.name ASC",
        desc: "c.name DESC",
    },
    crate::sorting::SortColumn {
        key: "set",
        asc: "c.set_code ASC, CAST(c.collector_number AS INTEGER) ASC, c.collector_number ASC",
        desc: "c.set_code DESC, CAST(c.collector_number AS INTEGER) DESC, c.collector_number DESC",
    },
    crate::sorting::SortColumn {
        key: "type",
        asc: "c.type_line ASC NULLS LAST",
        desc: "c.type_line DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "rarity",
        asc: "",  // filled below — a const cannot format
        desc: "",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "c.price_usd ASC NULLS LAST",
        desc: "c.price_usd DESC NULLS LAST",
    },
];
```

`RARITY_RANK` cannot be interpolated into a `const`. Write the two rarity clauses out in
full instead of referencing it, and delete `RARITY_RANK`:

```rust
    crate::sorting::SortColumn {
        key: "rarity",
        asc: "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 \
              WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END ASC",
        desc: "CASE c.rarity WHEN 'common' THEN 0 WHEN 'uncommon' THEN 1 WHEN 'rare' THEN 2 \
               WHEN 'mythic' THEN 3 WHEN 'special' THEN 4 WHEN 'bonus' THEN 5 ELSE 6 END DESC",
    },
```

Replace the `match` at `:252-262` with:

```rust
    // The default when nothing is asked for. `bm25` returns *smaller* numbers for better
    // matches, so plain ascending order is best-first; the weights are (name, type_line,
    // search_text), so a card whose name is what was typed beats one that merely mentions
    // it. Without a query there is nothing to be relevant to, and `idx_cards_name` gives
    // alphabetical order without sorting 116 k rows.
    //
    // `ORDER_NAME` already ends in `c.id ASC`, so the fallback carries its own tiebreak and
    // `order_by` appends a harmless second one. The bm25 fallback does not, and needs it.
    let fallback = if ranked {
        "bm25(cards_fts, 10.0, 1.0, 1.0) ASC, c.name ASC"
    } else {
        "c.name ASC, c.released_at DESC"
    };
    let order = crate::sorting::order_by(req.sort.as_deref(), SEARCH_SORTS, fallback, "c.id ASC");
```

`ORDER_NAME` loses its last term to the builder; update its doc comment to say the tiebreak
now comes from `sorting::order_by`, or delete the constant if nothing else reads it. The
`"released"` key is not in `SEARCH_SORTS`: the search table has no Released column, the
frontend has never sent it, and an order nothing can reach is dead code.

`order` is now a `String` rather than a `&str`; the `format!` at `:291` already interpolates
it and needs no change.

- [ ] **Step 6: Apply the two-step page query — only if Step 2 said so**

Replace the page SQL's `FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?`
with a form that sorts a lean inner query and fetches columns for the survivors:

```rust
    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout, c.oracle_id, c.finishes,
                coalesce((SELECT sum(e.quantity) FROM collection_entries e
                           WHERE e.card_id = c.id), 0),
                EXISTS (SELECT 1 FROM wishlist_entries w
                         WHERE w.card_id = c.id
                            OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL
                                AND w.oracle_id = c.oracle_id))
         FROM (SELECT c.rowid AS rid, row_number() OVER () AS rn
                 FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?) p
         JOIN cards c ON c.rowid = p.rid
         ORDER BY p.rn"
    );
```

`row_number() OVER ()` with no `ORDER BY` inside it numbers rows **in the order the
subquery produced them**, which is the sort — so the outer query can restore that order
without re-evaluating `bm25`, which is illegal outside the FTS join. Confirm this with the
paging test from Step 3 rather than by reading; if it does not hold, keep the flat query and
record the measurement as the reason.

- [ ] **Step 7: Run the tests**

```bash
cd src-tauri && cargo test
```

Expected: PASS, whole suite.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src-tauri/src/search.rs
git commit -m "feat(search): order results by a list of columns, not one key

Five sortable columns behind sorting::order_by, with rarity as a rank
rather than a word and set as the binder order. The 'released' key goes:
no column reaches it and the frontend never sent it.

Measured on the live 116,590-row database: <numbers from Step 1>.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: `VirtualTable`

The component, tested on its own. Wired into no view yet.

**Files:**
- Create: `src/components/table/VirtualTable.tsx`, `src/components/table/SortableHeader.tsx`,
  `src/components/table/VirtualTable.test.tsx`

**Interfaces:**
- Consumes: `LAYER` (Task 1); `SortSpec`, `SortDir`, `sortTermOf`, `sortRankOf`, `ariaSortOf`
  (Task 2); `needsNextPage` from `@/features/search/useCardSearch`;
  `stopRowActivationKeys` from `@/lib/useDismissOnEscape`.
- Produces: `TableColumn<Row>`, `VirtualTable`, and the constants `TABLE_ROW_HEIGHT = 44`
  and `TABLE_HEADER_HEIGHT = 36`, which Tasks 6–8 import instead of redeclaring.

- [ ] **Step 1: Write the failing test**

Create `src/components/table/VirtualTable.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SortSpec } from "@/lib/sort";
import { VirtualTable, type TableColumn } from "./VirtualTable";

interface Row {
  id: string;
  name: string;
  price: number;
}

const ROWS: Row[] = [
  { id: "a", name: "Black Lotus", price: 9 },
  { id: "b", name: "Shivan Dragon", price: 1 },
];

const COLUMNS: TableColumn<Row>[] = [
  { key: "name", width: "minmax(0,1fr)", header: "Name", sortable: true, cell: (r) => r.name },
  {
    key: "price",
    width: "6rem",
    header: "Price",
    sortable: true,
    firstDir: "desc",
    headerClassName: "text-right",
    cell: (r) => String(r.price),
  },
  { key: "actions", width: "2rem", header: "Actions", srOnlyHeader: true, cell: () => null },
];

function setup(sort: SortSpec = [], onSort = vi.fn()) {
  render(
    <VirtualTable
      rows={ROWS}
      columns={COLUMNS}
      label="Test rows"
      total={2}
      listKey="k"
      onNeedNextPage={() => {}}
      sort={sort}
      onSort={onSort}
    />,
  );
  return onSort;
}

describe("VirtualTable's header", () => {
  it("names every column, including the one with nothing to show", () => {
    setup();
    expect(screen.getAllByRole("columnheader")).toHaveLength(3);
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeInTheDocument();
  });

  it("makes a sortable column a button and leaves the rest alone", () => {
    setup();
    expect(screen.getByRole("button", { name: /^Name/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Actions/ })).not.toBeInTheDocument();
  });

  /**
   * `aria-sort` on *every* sorted column rather than only the first: the alternative is
   * telling assistive tech that a two-key sort has one key.
   */
  it("states the direction of every sorted column", () => {
    setup([
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
    expect(screen.getByRole("columnheader", { name: /^Name/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    expect(screen.getByRole("columnheader", { name: /^Price/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(screen.getByRole("columnheader", { name: "Actions" })).not.toHaveAttribute("aria-sort");
  });

  /**
   * WCAG 2.5.3: an accessible name that overrides the visible one has to *begin* with it,
   * or the column stops being addressable by the word written on it.
   */
  it("says where a column sits in a multi-key sort, after its own name", () => {
    setup([
      { key: "name", dir: "asc" },
      { key: "price", dir: "desc" },
    ]);
    expect(screen.getByRole("button", { name: "Name, sort priority 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Price, sort priority 2" })).toBeInTheDocument();
  });

  it("says nothing about priority when one column is the whole sort", () => {
    setup([{ key: "name", dir: "asc" }]);
    expect(screen.getByRole("button", { name: "Name" })).toBeInTheDocument();
  });

  it("reports a plain press as replacing the sort and a shifted one as adding to it", async () => {
    const user = userEvent.setup();
    const onSort = setup();

    await user.click(screen.getByRole("button", { name: "Name" }));
    expect(onSort).toHaveBeenLastCalledWith("name", false);

    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: "Price" }));
    await user.keyboard("{/Shift}");
    expect(onSort).toHaveBeenLastCalledWith("price", true);
  });
});

describe("VirtualTable's rows", () => {
  it("tells assistive tech how many rows there are, header included", () => {
    setup();
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "3");
  });

  /** A capped count is unknown, and ARIA spells unknown `-1`. 5 000 would be a smaller lie. */
  it("says the count is unknown when it is capped", () => {
    render(
      <VirtualTable
        rows={ROWS}
        columns={COLUMNS}
        label="Test rows"
        total={null}
        listKey="k"
        onNeedNextPage={() => {}}
        sort={[]}
        onSort={() => {}}
      />,
    );
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "-1");
  });

  /**
   * A row is `position: absolute` *and* transformed, so it is a stacking context and an open
   * popup inside it cannot lift itself over the next row — the row has to come forward. As
   * far as the rows and no further: the header above is a layer up, and a row lifted to its
   * level would scroll over it.
   */
  it("lifts a row holding an open popup, and no higher than the header", () => {
    setup();
    const rows = screen.getAllByRole("row");
    expect(rows[1]).toHaveClass("has-[[aria-expanded=true]]:z-10");
    expect(rows[0]).toHaveClass("z-20");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run src/components/table/VirtualTable.test.tsx
```

Expected: FAIL — `Failed to resolve import "./VirtualTable"`.

- [ ] **Step 3: Write `SortableHeader`**

Create `src/components/table/SortableHeader.tsx`:

```tsx
import { ArrowDown, ArrowUp } from "lucide-react";
import { ariaSortOf, sortRankOf, sortTermOf, type SortSpec } from "@/lib/sort";
import { cn } from "@/lib/utils";

const FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * One column's header.
 *
 * The `role="columnheader"` element carries `aria-sort` and the `<button>` inside it carries
 * the press, which is the split ARIA asks for — a header is not a control, and a control is
 * not a header.
 *
 * `aria-sort` is set on **every** sorted column rather than only the first. The alternative
 * is telling assistive tech that a two-key sort has one key.
 */
export function SortableHeader({
  label,
  ariaLabel,
  title,
  sortKey,
  spec,
  onSort,
  className,
}: {
  label: string;
  /** Overrides the accessible name. Must *begin* with `label` — WCAG 2.5.3. */
  ariaLabel?: string;
  title?: string;
  sortKey: string;
  spec: SortSpec;
  onSort: (key: string, additive: boolean) => void;
  className?: string;
}) {
  const term = sortTermOf(spec, sortKey);
  const rank = sortRankOf(spec, sortKey);
  const Arrow = term?.dir === "desc" ? ArrowDown : ArrowUp;
  // Only when there is more than one, because "1 of 1" is a number that says nothing and
  // this row is 36px tall.
  const showRank = rank !== null && spec.length > 1;

  // Label first, always: an accessible name that does not begin with the visible word takes
  // the column out of reach of anyone driving the app by voice.
  const name = [ariaLabel ?? label, showRank ? `sort priority ${rank}` : null]
    .filter(Boolean)
    .join(", ");

  return (
    <span role="columnheader" aria-sort={ariaSortOf(term)} className={cn("min-w-0", className)}>
      <button
        type="button"
        // One handler for the mouse and the keyboard both: Chromium reports `shiftKey` on
        // the click it synthesises from Shift+Enter, so the additive press needs no second
        // path and no second thing for a reader to learn.
        onClick={(e) => onSort(sortKey, e.shiftKey)}
        aria-label={name === label ? undefined : name}
        title={title ?? `Sort by ${label} — Shift-click to add to the sort`}
        className={cn(
          "flex w-full min-w-0 items-center gap-1 text-left",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
          term && "text-text",
          className?.includes("text-right") && "justify-end",
        )}
      >
        <span className="truncate">{label}</span>
        {term && <Arrow className="size-3 shrink-0" aria-hidden="true" />}
        {showRank && (
          <span
            aria-hidden="true"
            className="shrink-0 rounded-sm bg-surface px-1 text-[0.65rem] leading-tight text-dim"
          >
            {rank}
          </span>
        )}
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Write `VirtualTable`**

Create `src/components/table/VirtualTable.tsx`:

```tsx
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { needsNextPage } from "@/features/search/useCardSearch";
import { LAYER } from "@/lib/layers";
import type { SortDir, SortSpec } from "@/lib/sort";
import { stopRowActivationKeys } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { SortableHeader } from "./SortableHeader";

/** Row height in px, shared by all three tables so the app has one row pitch. */
export const TABLE_ROW_HEIGHT = 44;

/** Height of the sticky header row, which the virtualiser has to account for. */
export const TABLE_HEADER_HEIGHT = 36;

/**
 * Keyboard focus on a row: an outline, never a ring. The offset is *negative* because rows
 * are stacked flush inside a scroller, and an outline standing 2px off one would be drawn
 * over its neighbours and clipped at the ends of the list.
 */
const ROW_FOCUS =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

export interface TableColumn<Row> {
  /** Stable id. Also the sort key sent to the backend when `sortable`. */
  key: string;
  /** Grid track — `"minmax(0,2fr)"`, `"8rem"`. The template is joined from these. */
  width: string;
  header: string;
  /** Not drawn, still named: an unnamed column is announced as "column 6" on every row. */
  srOnlyHeader?: boolean;
  /** Rides as the column's tooltip. */
  headerTitle?: string;
  /** Overrides the accessible name. Must *begin* with `header` — WCAG 2.5.3. */
  headerLabel?: string;
  headerClassName?: string;
  sortable?: boolean;
  /** Which direction one press asks for first. Ascending unless stated. */
  firstDir?: SortDir;
  cell: (row: Row) => ReactNode;
  cellClassName?: string;
  /**
   * The cell holds a control. Applies `data-no-drag` and swallows the click and the two
   * activation keys, so editing a quantity does not also open the card and typing `12` does
   * not scroll the list a screenful.
   */
  interactive?: boolean;
}

export interface RowRenderProps {
  className: string;
  style: React.CSSProperties;
  role: "row";
  "aria-rowindex": number;
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  children: ReactNode;
}

/**
 * The app's one virtualised table: a scroller, a sticky sortable header, and absolutely
 * positioned rows.
 *
 * One component because there were three, and they differed in their columns rather than in
 * their behaviour — same scroller, same `scrollMargin`, same paging effect, same
 * scroll-reset, same row geometry, same `role="cell"` wrapper, same trio of guards on every
 * interactive cell. What actually differs stays a callback: `renderRow`, because two of the
 * three wrap their row in a drag source, and `extraHeight`, because two of the three grow a
 * row by the reconciler's flagged band.
 *
 * The column template is an inline style rather than a Tailwind arbitrary value on purpose:
 * Tailwind scans source text for whole class names, so a template joined at runtime would
 * emit no rule at all.
 */
export function VirtualTable<Row>({
  rows,
  columns,
  label,
  total,
  listKey,
  onNeedNextPage,
  sort,
  onSort,
  extraHeight,
  onActivate,
  isSelected,
  rowClassName,
  renderRow,
}: {
  rows: Row[];
  columns: TableColumn<Row>[];
  /** Names the table for assistive tech — "Search results", "Your collection". */
  label: string;
  /**
   * Rows matching the filters, not rows loaded. `null` when the count is capped: ARIA
   * spells "unknown" `-1`, and 5 000 would be a smaller lie than 20 but still a lie.
   */
  total: number | null;
  /** Identity of the current list, so a new one starts at the top. */
  listKey: string;
  onNeedNextPage: () => void;
  sort: SortSpec;
  onSort: (key: string, additive: boolean) => void;
  /** Extra px this row needs beyond {@link TABLE_ROW_HEIGHT}. */
  extraHeight?: (row: Row) => number;
  /** Click, Enter and Space on a row. Omitted makes rows inert. */
  onActivate?: (row: Row) => void;
  isSelected?: (row: Row) => boolean;
  rowClassName?: (row: Row) => string | undefined;
  /** Wraps the row. The default is a plain `div`; two callers make it a drag source. */
  renderRow?: (props: RowRenderProps, row: Row) => ReactNode;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const template = useMemo(() => columns.map((c) => c.width).join(" "), [columns]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Exact rather than estimated: a row that carries the reconciler's band is taller, and a
    // virtualiser told every row is 44px would overlap the one below it by exactly that band.
    estimateSize: (index) => {
      const row = rows[index];
      return TABLE_ROW_HEIGHT + (row && extraHeight ? extraHeight(row) : 0);
    },
    overscan: 10,
    // The sticky header shares the scroll container with the rows, so the list does not
    // start at the container's origin.
    scrollMargin: TABLE_HEADER_HEIGHT,
  });

  // Row heights are cached from the first `estimateSize` call, so a page that lands with a
  // taller row in it — or a fix that shortens one — has to say so, or the rows keep the old
  // pitch. Usually the empty string: nothing is flagged in a healthy list.
  const heightKey = useMemo(
    () =>
      extraHeight
        ? rows
            .map((r, i) => (extraHeight(r) > 0 ? i : -1))
            .filter((i) => i >= 0)
            .join(",")
        : "",
    [rows, extraHeight],
  );
  useEffect(() => {
    virtualizer.measure();
  }, [heightKey, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length ? virtualRows[virtualRows.length - 1].index : -1;

  // A new list reuses this scroll container, and a browser does not reset scrollTop for new
  // content — it clamps the old offset into the new, usually far shorter, list. Changing the
  // sort changes `listKey`, so a re-sorted list starts at the top for free.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [listKey, virtualizer]);

  // Paging is driven by the virtualiser's window rather than a scroll handler: it already
  // knows which row is at the bottom, and it recomputes on resize too, which a scroll event
  // never fires for. The guards live with the query, in the page above.
  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      role="table"
      aria-label={label}
      // Every matching row plus the header, not just the rows currently in the DOM —
      // otherwise a virtualised list tells assistive tech the database holds 20 cards.
      aria-rowcount={total === null ? -1 : total + 1}
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border"
    >
      {/* Sticky inside the scroll container rather than sitting above it: a header outside
          the scroller is wider than the rows by exactly the scrollbar, and the columns drift
          apart by that much as soon as the list overflows. */}
      <div
        role="row"
        aria-rowindex={1}
        style={{ height: TABLE_HEADER_HEIGHT, gridTemplateColumns: template }}
        className={cn(
          "grid items-center gap-3 border-b border-border bg-surface px-3 text-xs text-dim",
          "sticky top-0",
          LAYER.header,
        )}
      >
        {columns.map((column) =>
          column.sortable ? (
            <SortableHeader
              key={column.key}
              label={column.header}
              ariaLabel={column.headerLabel}
              title={column.headerTitle}
              sortKey={column.key}
              spec={sort}
              onSort={onSort}
              className={column.headerClassName}
            />
          ) : (
            <span
              key={column.key}
              role="columnheader"
              title={column.headerTitle}
              aria-label={column.headerLabel}
              className={cn(
                // `truncate` on every label, because the flexible tracks collapse to nothing
                // in a narrow window with the card pane open — and a header that overflows a
                // zero-width track is drawn over the next column's, which reads as a
                // rendering fault rather than as a squeeze.
                column.srOnlyHeader ? "sr-only" : "truncate",
                column.headerClassName,
              )}
            >
              {column.header}
            </span>
          ),
        )}
      </div>

      {/* Holds the scrollbar open to the full list height while the rows inside it are
          positioned absolutely. */}
      <div role="rowgroup" style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((v) => {
          const row = rows[v.index];
          if (!row) return null;
          const extra = extraHeight?.(row) ?? 0;
          const props: RowRenderProps = {
            role: "row",
            "aria-rowindex": v.index + 2,
            tabIndex: onActivate ? 0 : undefined,
            onClick: onActivate ? () => onActivate(row) : undefined,
            onKeyDown: onActivate
              ? (e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  // Space scrolls the container it is pressed in, which would jump the list
                  // by a screen at the same time as opening the card.
                  e.preventDefault();
                  onActivate(row);
                }
              : undefined,
            className: cn(
              "grid items-center gap-3",
              // `group`: a row's controls show themselves on hover, and on the row taking
              // focus — which is the keyboard's version of hover.
              "group absolute inset-x-0 top-0 border-b border-border/50 px-3",
              // A row is positioned *and* transformed, which makes it a stacking context —
              // so an open popup's own layer cannot lift it over the next row, which paints
              // later simply for being later in the DOM. The row it is open in has to come
              // forward instead, as far as the rows and no further: the sticky header above
              // is a layer up, because a row lifted to its level would scroll over it.
              LAYER.raisedWhenPopupOpen,
              "text-sm transition-colors duration-150 motion-reduce:transition-none",
              ROW_FOCUS,
              onActivate && "cursor-pointer",
              // Which row the open pane is about. A quiet surface rather than gold: forty
              // rows are on screen and the one being read is already beside the pane.
              isSelected?.(row) ? "bg-surface text-text" : "hover:bg-surface/60",
              // Last, so a caller's own state colour wins over the selection colour.
              rowClassName?.(row),
            ),
            // `start` is measured from the scroll container, which the header shares; this
            // div begins below it, so the header's height comes back off. The row tracks are
            // pinned rather than left to `auto` because a flagged band is positioned over
            // the second one — an auto track would collapse it and re-centre the cells
            // across a height they do not occupy.
            style: {
              height: v.size,
              transform: `translateY(${v.start - TABLE_HEADER_HEIGHT}px)`,
              gridTemplateColumns: template,
              gridTemplateRows: extra > 0 ? `${TABLE_ROW_HEIGHT}px ${extra}px` : undefined,
            },
            children: columns.map((column) => (
              <span
                key={column.key}
                role="cell"
                className={cn("min-w-0", column.cellClassName)}
                {...(column.interactive
                  ? {
                      "data-no-drag": "",
                      onClick: (e: React.MouseEvent) => e.stopPropagation(),
                      onKeyDown: stopRowActivationKeys,
                    }
                  : {})}
              >
                {column.cell(row)}
              </span>
            )),
          };
          // Keyed by row position, not by id: two pages fetched either side of a write can
          // carry the same row twice, and a duplicate key is a React warning plus a dropped
          // row.
          return renderRow ? (
            <div key={v.key} className="contents">
              {renderRow(props, row)}
            </div>
          ) : (
            <div key={v.key} {...props} />
          );
        })}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the test**

```bash
npx vitest run src/components/table/VirtualTable.test.tsx
```

Expected: PASS, 9 tests. `@tanstack/react-virtual` measures nothing in jsdom, so it renders
the rows it estimates; the existing `SearchPage.test.tsx` already relies on that.

If the `renderRow` wrapper's `className="contents"` div breaks `getAllByRole("row")`
ordering, drop the wrapper and have `renderRow` receive `key` in its props instead.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/components/table
git commit -m "feat(table): one virtualised table for the three that were copies

Same scroller, same scrollMargin, same paging effect, same row geometry,
same cell guards — the three differed in their columns, so columns become
data and the two things that really differ stay callbacks. The header is
sortable, with aria-sort on every sorted column rather than only the first.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: The search table moves onto it, with sortable headers

**Files:**
- Modify: `src/features/search/SearchPage.tsx` (lines 19-37 constants, 65-119 `Row`,
  388-513 the table), `src/features/search/useCardSearch.ts:157-274`, `src/lib/ipc.ts:62`,
  `src/features/search/SearchPage.test.tsx`

**Interfaces:**
- Consumes: `VirtualTable`, `TableColumn`, `TABLE_ROW_HEIGHT` (Task 5); `applySort`,
  `SortSpec` (Task 2); the Rust keys `name` | `set` | `type` | `rarity` | `price` (Task 4).
- Produces: `CardSearch.sort: SortSpec<SearchSortKey>` and
  `CardSearch.toggleSort: (key: string, additive: boolean) => void`, which the deck editor's
  docked panel does not use (it shows `CardGrid`, not a table) but must still compile against.

- [ ] **Step 1: Widen the wire type**

In `src/lib/ipc.ts`, add near the top of the file's type section:

```ts
import type { SortSpec } from "./sort";

/** The search table's sortable columns. Mirrors `SEARCH_SORTS` in `src-tauri/src/search.rs`. */
export type SearchSortKey = "name" | "set" | "type" | "rarity" | "price";
```

and replace line 62:

```ts
  /**
   * How to order the page: columns in priority order. Empty or absent is the default —
   * relevance when `text` is set, name order when it is not. A key the backend does not
   * know is dropped there rather than interpolated.
   */
  sort?: SortSpec<SearchSortKey>;
```

- [ ] **Step 2: Write the failing tests**

Add to `src/features/search/SearchPage.test.tsx`:

```tsx
  it("sends nothing about sorting until a header is pressed", async () => {
    renderSearch();
    await screen.findByRole("row", { name: /Black Lotus/ });
    expect(lastSearchRequest().sort).toBeUndefined();
  });

  it("asks the backend for the column a pressed header names", async () => {
    const user = userEvent.setup();
    renderSearch();
    await screen.findByRole("row", { name: /Black Lotus/ });

    await user.click(screen.getByRole("button", { name: "Price" }));
    await waitFor(() => expect(lastSearchRequest().sort).toEqual([{ key: "price", dir: "desc" }]));
  });

  /**
   * The whole point of the feature, and the thing a single-key sort cannot express:
   * cheapest within each rarity.
   */
  it("builds a two-key sort from a shifted press and keeps the first key first", async () => {
    const user = userEvent.setup();
    renderSearch();
    await screen.findByRole("row", { name: /Black Lotus/ });

    await user.click(screen.getByRole("button", { name: "Rarity" }));
    await user.keyboard("{Shift>}");
    await user.click(screen.getByRole("button", { name: /^Price/ }));
    await user.keyboard("{/Shift}");

    await waitFor(() =>
      expect(lastSearchRequest().sort).toEqual([
        { key: "rarity", dir: "asc" },
        { key: "price", dir: "desc" },
      ]),
    );
  });
```

Use whatever the file already has for rendering and for reading the last `searchCards`
payload; if there is no `lastSearchRequest` helper, add one over the existing `ipc` mock:

```tsx
const lastSearchRequest = () =>
  vi.mocked(ipc.searchCards).mock.calls.at(-1)![0] as SearchRequest;
```

- [ ] **Step 3: Run them and watch them fail**

```bash
npx vitest run src/features/search/SearchPage.test.tsx
```

Expected: FAIL — `Unable to find role="button" with name "Price"`.

- [ ] **Step 4: Add sort state to `useCardSearch`**

In `src/features/search/useCardSearch.ts`:

```ts
import { applySort, type SortSpec } from "@/lib/sort";
import type { SearchSortKey } from "@/lib/ipc";

/**
 * Which direction one press on each column asks for first.
 *
 * Descending on price because "highest first" is what clicking a money column means, and
 * ascending on everything that reads as a list.
 */
const SEARCH_FIRST_DIR: Record<SearchSortKey, "asc" | "desc"> = {
  name: "asc",
  set: "asc",
  type: "asc",
  rarity: "asc",
  price: "desc",
};
```

Inside the hook, beside the other filter state:

```ts
  const [sort, setSort] = useState<SortSpec<SearchSortKey>>([]);
```

Add to `queryKey`, after the `owned` segment:

```ts
    // The whole sort in one segment: a differently-ordered page is a different answer, and
    // must not be served from the cache of the order before it.
    sort.map((t) => `${t.key}:${t.dir}`).join(","),
```

Add to the `ipc.searchCards({...})` payload:

```ts
        // Absent rather than `[]` when nothing is sorted, so an untouched table produces
        // exactly the payload it always did.
        sort: sort.length > 0 ? sort : undefined,
```

Return from the hook, beside `activeCount`:

```ts
    /** The columns this list is ordered by, first one deciding. Empty is the view default. */
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as SearchSortKey, {
          additive,
          firstDir: SEARCH_FIRST_DIR[key as SearchSortKey] ?? "asc",
        }),
      ),
```

Leave `resetAll` alone: a sort is not a filter, it is not counted by `activeFilterCount`,
and clearing the filters should not also throw away the order the reader chose.

- [ ] **Step 5: Rewrite the search table as columns**

In `src/features/search/SearchPage.tsx`, delete `ROW_HEIGHT`, `HEADER_HEIGHT`, `GRID`,
`ROW_FOCUS`, the whole `Row` component and the entire `<div role="table">` block, and the
`useVirtualizer` in `SearchPage` along with the `scrollRef`, the `scrollToOffset` effect and
the table's paging effect (all four now live in `VirtualTable`). `SearchPage` keeps only the
grid's prefetch effect and passes `search` down.

Add above `Results`:

```tsx
/**
 * The six columns of the search table.
 *
 * Name and type are `2fr`/`1fr` rather than `1fr` and a 16rem cap. A capped track is
 * *inflexible*: grid grows it to its cap out of the free space **before** any `fr` track is
 * fed, so on a narrow window with the card pane open the type column took its 16rem and the
 * name column was left with nothing — a row of mana symbols overflowing a zero-width track
 * across the set beside it. Two flexible tracks share the squeeze instead: at 1280px with
 * the pane open every column keeps a readable share, and closed they measure 381/190 where
 * the cap gave 315/256 — the name, which is what identifies a row, now truncates last.
 *
 * The keys are the backend's, verbatim: `SEARCH_SORTS` in `src-tauri/src/search.rs`. A key
 * that does not match one there is dropped silently at the far end, which is a column whose
 * header does nothing.
 */
const COLUMNS: TableColumn<CardSummary>[] = [
  {
    key: "name",
    width: "minmax(0,2fr)",
    header: "Name",
    sortable: true,
    cellClassName: "flex min-w-0 items-baseline gap-2",
    cell: (card) => (
      <>
        <span className="truncate">{card.name}</span>
        {/* The printed symbols, from the bundled font — the same rule as the detail pane:
            a cost is read as symbols, and `{1}{W}{U}` is a wire format. */}
        <ManaText source={card.manaCost} className="shrink-0 text-xs" />
        {/* The two facts the tile carries over its art, in the cell that identifies the row —
            because they are facts about the *card*, and the other five columns are about the
            printing. One truth, stated the same way in both layouts. */}
        <OwnedBadge owned={card.ownedQuantity} wishlisted={card.wishlisted} />
      </>
    ),
  },
  {
    key: "set",
    width: "8rem",
    header: "Set",
    sortable: true,
    cellClassName: "truncate font-mono text-dim",
    // `setName` is nullable and the code is not, so the code is what is shown; the full name
    // rides along as the tooltip when there is one. Mono because a collector number is data.
    cell: (card) => (
      <span title={card.setName ?? undefined}>
        {card.setCode.toUpperCase()} · {card.collectorNumber}
      </span>
    ),
  },
  {
    key: "type",
    width: "minmax(0,1fr)",
    header: "Type",
    sortable: true,
    cellClassName: "truncate text-dim",
    cell: (card) => card.typeLine ?? "—",
  },
  {
    key: "rarity",
    width: "6rem",
    header: "Rarity",
    sortable: true,
    // Gem dot plus tinted word, exactly as the grid tiles caption a rarity — the two views
    // show the same fact and there is no reason for it to look like two facts.
    cell: (card) => <RarityGem rarity={card.rarity} withLabel className="max-w-full" />,
  },
  {
    key: "price",
    width: "6rem",
    header: "Price",
    sortable: true,
    firstDir: "desc",
    // Spec §5: a price is never shown without saying how old it is. A 36px header row has no
    // space for the sentence, so it rides as the column's tooltip and inside its accessible
    // name — which *begins* with the visible word, which is what keeps an overriding
    // `aria-label` legitimate here (WCAG 2.5.3, label in name).
    headerTitle: PRICES_AS_OF,
    headerLabel: `Price. ${PRICES_AS_OF}`,
    headerClassName: "text-right",
    cellClassName: "text-right font-mono tabular-nums",
    cell: (card) => usdPrice(card.priceUsd),
  },
  {
    key: "actions",
    width: "2.5rem",
    // Nothing to show, and a header a screen reader still needs: an unnamed column is
    // announced as "column 6" for every row.
    header: "Actions",
    srOnlyHeader: true,
    interactive: true,
    cell: (card) => (
      <AddToCollectionButton
        className={REVEAL_ON_HOVER}
        target={{
          cardId: card.id,
          name: card.name,
          setCode: card.setCode,
          collectorNumber: card.collectorNumber,
          // Both ride on `CardSummary`, which is what lets a row be honest: the popup offers
          // the finishes this printing exists in — the backend checks the enum and not the
          // card, so a foil-only printing would otherwise take a nonfoil entry — and a wish
          // made here can be for the card rather than for this printing.
          oracleId: card.oracleId,
          finishes: parseFinishes(card.finishes),
        }}
      />
    ),
  },
];
```

`firstDir` on the `price` column is documentation; the hook's `SEARCH_FIRST_DIR` is what
actually decides, because the hook owns the state. Keep both in step.

In `Results`, replace the whole table branch with:

```tsx
          <VirtualTable
            rows={rows}
            columns={COLUMNS}
            label="Search results"
            // `null` is ARIA's "the total is unknown", which is exactly what a capped count
            // is: 5 000 would be a smaller lie than 20, but still a lie.
            total={totalIsCapped ? null : total}
            listKey={searchKey}
            sort={search.sort}
            onSort={search.toggleSort}
            // A row opens the card, from the mouse and from the keyboard both — the table is
            // the view for comparing prices, and being unable to open the one you picked
            // would make it a dead end for anyone not using a mouse.
            onActivate={(card) => selectCard(card.id)}
            isSelected={(card) => card.id === selectedCardId}
            onNeedNextPage={() => {
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
```

`Results` no longer needs `virtualizer`, `virtualRows` or `scrollRef` as props; drop them
from its signature and from `SearchPage`'s call.

- [ ] **Step 6: Run the search tests**

```bash
npx vitest run src/features/search
```

Expected: PASS. Two existing assertions need updating and both are expected:
`SearchPage.test.tsx:548`'s header/row layering test now finds the classes on
`VirtualTable`'s output (same strings, so it should pass unchanged — if it does not, the
extraction changed a class and that is the bug), and any test asserting a bare
`role="columnheader"` name now finds a button inside it.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/features/search src/lib/ipc.ts
git commit -m "feat(search): sort the results table by clicking its headers

Five sortable columns, Shift-click to build a two- or three-key sort. The
table view becomes column data over VirtualTable; the sort rides in the
query key, so a re-sorted list starts at the top through the scroll-reset
that was already there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: The collection

**Files:**
- Modify: `src-tauri/src/collection.rs:597-598` (field), `:761-779` (`order_by`),
  `src/lib/ipc.ts:361`, `src/features/collection/useCollection.ts:21-36,120,182,187`,
  `src/features/collection/CollectionFilterBar.tsx:130-146`,
  `src/features/collection/CollectionTable.tsx`,
  `src/features/collection/CollectionPage.test.tsx`,
  `src/features/collection/CollectionFilterBar.test.tsx`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: `CollectionSortKey = "name" | "set" | "finish" | "quantity" | "value" | "added" | "price"`.

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/collection.rs`'s test module, using its existing fixture helpers:

```rust
    /// The Value column shows unit price × copies, so its header sorts by that. A column
    /// that reorders by something other than the figure printed in it is a column that lies.
    #[test]
    fn value_sorts_by_the_total_and_not_by_the_unit_price() {
        // Two entries: one cheap card held ten times, one dear card held once.
        let conn = fixture_with_entries(&[("cheap", 2.0, 10), ("dear", 15.0, 1)]);
        let page = list_entries(
            &conn,
            &CollectionQuery {
                sort: Some(vec![term("value", "desc")]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.rows[0].name.as_deref(), Some("cheap"));

        // And the unit-price order, which the filter bar still offers, disagrees with it.
        let page = list_entries(
            &conn,
            &CollectionQuery {
                sort: Some(vec![term("price", "desc")]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.rows[0].name.as_deref(), Some("dear"));
    }

    #[test]
    fn a_two_key_sort_pages_without_repeating_a_row() {
        let conn = fixture_with_tied_entries(10);
        let ids = |offset: u32| -> Vec<i64> {
            list_entries(
                &conn,
                &CollectionQuery {
                    sort: Some(vec![term("quantity", "desc"), term("name", "asc")]),
                    limit: 5,
                    offset,
                    ..Default::default()
                },
            )
            .unwrap()
            .rows
            .iter()
            .map(|r| r.id)
            .collect()
        };
        let mut all = ids(0);
        all.extend(ids(5));
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len(), "a row appeared on both pages");
    }
```

Add the same `fn term` helper as Task 4 Step 3.

- [ ] **Step 2: Run and watch fail**

```bash
cd src-tauri && cargo test collection
```

Expected: FAIL to compile — `expected Option<String>, found Option<Vec<SortTerm>>`.

- [ ] **Step 3: Replace `collection.rs`'s `order_by`**

Change the field at `:597-598` to
`pub sort: Option<Vec<crate::sorting::SortTerm>>,` and replace `fn order_by` with:

```rust
/// The columns the collection table's headers can sort on, plus the two the filter bar's
/// select offers that have no column to click.
///
/// `set` is the binder order: natural collector number, which is a `CAST` because ~9% of
/// them are not numeric (`741z`, `1★`, `A-123`) and a plain string sort puts `100` before
/// `2`. `name` coalesces to the card id so orphans sort under something rather than at the
/// top under an empty string.
///
/// `value` and `price` are two different questions about the same column and both are real:
/// `value` is what the row is worth, which is the figure the Value cell prints, and `price`
/// is what one copy costs — the order a reader means by "what is my most expensive card".
/// The header takes `value`, because a header must sort by what it shows; `price` stays
/// reachable from the select.
///
/// `condition` ranks rather than sorts alphabetically: `DMG` before `LP` is not a grade
/// order.
const COLLECTION_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "coalesce(c.name, e.card_id) ASC",
        desc: "coalesce(c.name, e.card_id) DESC",
    },
    crate::sorting::SortColumn {
        key: "set",
        asc: "e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC, e.collector_number ASC",
        desc: "e.set_code DESC, CAST(e.collector_number AS INTEGER) DESC, e.collector_number DESC",
    },
    crate::sorting::SortColumn {
        key: "finish",
        asc: "e.finish ASC, CASE e.condition WHEN 'NM' THEN 0 WHEN 'LP' THEN 1 \
              WHEN 'MP' THEN 2 WHEN 'HP' THEN 3 WHEN 'DMG' THEN 4 ELSE 5 END ASC",
        desc: "e.finish DESC, CASE e.condition WHEN 'NM' THEN 0 WHEN 'LP' THEN 1 \
               WHEN 'MP' THEN 2 WHEN 'HP' THEN 3 WHEN 'DMG' THEN 4 ELSE 5 END DESC",
    },
    crate::sorting::SortColumn {
        key: "quantity",
        asc: "e.quantity ASC",
        desc: "e.quantity DESC",
    },
    crate::sorting::SortColumn {
        key: "value",
        asc: "unit_price_usd * e.quantity ASC NULLS LAST",
        desc: "unit_price_usd * e.quantity DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "unit_price_usd ASC NULLS LAST",
        desc: "unit_price_usd DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "added",
        asc: "e.created_at ASC",
        desc: "e.created_at DESC",
    },
];

/// Name order, with the orphans under their card id rather than at the top under an empty
/// string. The tiebreak is appended by `sorting::order_by`.
const COLLECTION_DEFAULT_ORDER: &str =
    "coalesce(c.name, e.card_id) ASC, e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC";
```

At the call site, replace `order_by(q.sort.as_deref())` with:

```rust
    let order = crate::sorting::order_by(
        q.sort.as_deref(),
        COLLECTION_SORTS,
        COLLECTION_DEFAULT_ORDER,
        "e.id ASC",
    );
```

- [ ] **Step 4: Run the Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: PASS. Existing tests setting `sort: Some("added".into())` need rewriting to
`sort: Some(vec![term("added", "desc")])` — note the **direction moves to the caller**: the
old `added` key meant `created_at DESC` and now `desc` says so.

- [ ] **Step 5: Widen the wire type and the hook**

In `src/lib/ipc.ts`, replace line 361 with:

```ts
  /** How to order the list. Empty or absent is name order. */
  sort?: SortSpec<CollectionSortKey>;
```

and add beside `SearchSortKey`:

```ts
/**
 * The collection's sortable columns. `value` and `price` are two questions about the one
 * Value column: `value` is what the row is worth (the figure it prints, and what its header
 * sorts by), `price` what one copy costs. `added` has no column at all — both are reachable
 * only from the filter bar's select. Mirrors `COLLECTION_SORTS` in `src-tauri/src/collection.rs`.
 */
export type CollectionSortKey =
  | "name"
  | "set"
  | "finish"
  | "quantity"
  | "value"
  | "price"
  | "added";
```

In `src/features/collection/useCollection.ts`:

```ts
/** The orders the filter bar's select offers, in the order a reader reaches for them.
 *
 *  Named for what they answer rather than for the column they touch. Four of them have a
 *  header to click as well and two do not — "Recently added" has no column and cannot
 *  afford one, and unit price is the Value column's other question. */
export const COLLECTION_SORTS = [
  { value: "name", label: "Name" },
  { value: "set", label: "Set and number" },
  { value: "added", label: "Recently added" },
  { value: "quantity", label: "Most copies" },
  { value: "price", label: "Highest price" },
] as const satisfies readonly { value: CollectionSortKey; label: string }[];

/** Which direction one press on each column asks for first. */
const COLLECTION_FIRST_DIR: Record<CollectionSortKey, SortDir> = {
  name: "asc",
  set: "asc",
  finish: "asc",
  quantity: "desc",
  value: "desc",
  price: "desc",
  added: "desc",
};
```

Replace `const [sort, setSort] = useState<CollectionSort>("name")` with
`const [sort, setSort] = useState<SortSpec<CollectionSortKey>>([])`, put
`sort.map((t) => `${t.key}:${t.dir}`).join(",")` into `listKey` where the old string was,
send `sort: sort.length > 0 ? sort : undefined` in the payload, and return:

```ts
    sort,
    /** One press on a column header. `additive` is Shift being held. */
    toggleSort: (key: string, additive: boolean) =>
      setSort((spec) =>
        applySort(spec, key as CollectionSortKey, {
          additive,
          firstDir: COLLECTION_FIRST_DIR[key as CollectionSortKey] ?? "asc",
        }),
      ),
    /** The select's answer: one term, replacing whatever was there. */
    setSortKey: (key: CollectionSortKey) => setSort([{ key, dir: COLLECTION_FIRST_DIR[key] }]),
    /**
     * What the select shows. The spec's first term when the select offers it, `""` — read
     * as `Custom…` — when the sort starts from a column the select has no option for.
     */
    sortSelection: (sort.length === 0
      ? "name"
      : COLLECTION_SORTS.some((s) => s.value === sort[0].key)
        ? sort[0].key
        : "") as CollectionSortKey | "",
```

Keep `sort` out of the *summary* query's key, as the existing comment at `useCollection.ts:164`
requires — a summary does not change when the order does.

- [ ] **Step 6: Wire the select**

In `src/features/collection/CollectionFilterBar.tsx`, replace the select's `value` and
`onChange`:

```tsx
      <select
        id="collection-sort"
        value={collection.sortSelection}
        onChange={(e) => collection.setSortKey(e.target.value as CollectionSortKey)}
        className={cn(FILTER_CONTROL, FILTER_FOCUS, "border-border bg-surface px-2 text-dim")}
      >
        {/* Only reachable by *reading* it: picking it would be picking the sort you already
            have. Present because a select showing nothing at all is a control that looks
            broken, and because "Custom…" is the honest name for a sort built from headers
            the select has no option for. */}
        {collection.sortSelection === "" && (
          <option value="" disabled>
            Custom…
          </option>
        )}
        {COLLECTION_SORTS.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
```

- [ ] **Step 7: Rewrite `CollectionTable` as columns**

Delete `ROW_HEIGHT`, `HEADER_HEIGHT`, `GRID`, `ROW_FOCUS`, the virtualiser, the `reviewKey`
effect, the scroll-reset effect and the paging effect. Keep `DraggableRow` and
`conditionLabel`. Build `COLUMNS: TableColumn<CollectionRow>[]` from the existing six cells
verbatim — moving each `<span role="cell" className=…>`'s className to `cellClassName` and
its children to `cell`, marking the stepper and the remove columns `interactive: true`, and
keeping the flagged band inside the name column's `cell` where it is now. Keys and headers:

| key | width | header | sortable | firstDir |
| --- | --- | --- | --- | --- |
| `name` | `minmax(0,1fr)` | Name | yes | asc |
| `set` | `6.5rem` | Set | yes | asc |
| `finish` | `5.5rem` | Finish · condition | yes | asc |
| `quantity` | `7rem` | Copies | yes | desc |
| `value` | `5.5rem` | Value | yes | desc |
| `actions` | `2rem` | Actions (`srOnlyHeader`) | no | — |

The `value` column keeps `headerTitle: PRICES_AS_OF` and
`headerLabel: \`Value. ${PRICES_AS_OF}\``.

Render:

```tsx
    <VirtualTable
      rows={rows}
      columns={COLUMNS}
      label="Your collection"
      // A collection total is counted in full, so there is no unknown-count case here.
      total={total}
      listKey={listKey}
      sort={sort}
      onSort={onSort}
      // The reconciler's sentence is a band under the row it belongs to.
      extraHeight={(row) => (row.needsReview ? REVIEW_HEIGHT : 0)}
      onActivate={(row) => selectCard(row.cardId)}
      isSelected={(row) => row.cardId === selectedCardId}
      // A row emptied to zero is a record of a card the user no longer holds, and it says so
      // by receding rather than by disappearing.
      rowClassName={(row) => (row.quantity === 0 ? "text-dim" : undefined)}
      onNeedNextPage={onNeedNextPage}
      renderRow={(props, row) => (
        <DraggableRow cardId={row.cardId} name={row.name} {...props} />
      )}
    />
```

`CollectionTable` takes two new props, `sort: SortSpec<CollectionSortKey>` and
`onSort: (key: string, additive: boolean) => void`, threaded from `CollectionPage`'s
`useCollection()`.

- [ ] **Step 8: Run the collection tests**

```bash
npx vitest run src/features/collection
```

Expected: PASS. Update the filter-bar test's select assertions to the new option list, and
any test asserting on the old `sort: "name"` payload shape.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify
git add src/features/collection src/lib/ipc.ts src-tauri/src/collection.rs
git commit -m "feat(collection): sortable headers over the shared table

Five sortable columns and the select kept as one shared state — it sets a
single term and reads Custom… once the sort starts somewhere it has no
option for, which is how 'Recently added' and unit price survive having no
column. The Value header sorts by unit price × copies, which is the figure
the cell prints.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: The wishlist

**Files:**
- Modify: `src-tauri/src/wishlist.rs:53` (field), `:365-369` (the `match`),
  `src/lib/ipc.ts:473`, `src/features/wishlist/useWishlist.ts:25-30`,
  `src/features/wishlist/WishlistPage.tsx:431-456,467-760`,
  `src/features/wishlist/WishlistPage.test.tsx`

**Interfaces:**
- Produces: `WishlistSortKey = "name" | "owned" | "quantity" | "cost" | "price" | "added"`.

- [ ] **Step 1: Write the failing Rust test**

```rust
    /// The Cost column shows unit price × copies *still missing*, so its header sorts by
    /// that — a fulfilled wish costs nothing however dear the card is.
    #[test]
    fn cost_sorts_by_what_is_left_to_buy() {
        // A $100 card already owned, and a $10 card wanted four times over.
        let conn = fixture_with_wishes(&[("owned-dear", 100.0, 1, 1), ("wanted-cheap", 10.0, 4, 0)]);
        let page = list_wishes(
            &conn,
            &WishlistQuery {
                sort: Some(vec![term("cost", "desc")]),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.rows[0].name, "wanted-cheap");
    }
```

`fixture_with_wishes` takes `(name, unit price, wanted, owned)` and seeds a
`collection_entries` row for the owned copies. Add the same `fn term` helper.

- [ ] **Step 2: Run and watch fail**

```bash
cd src-tauri && cargo test wishlist
```

Expected: FAIL to compile.

- [ ] **Step 3: Replace `wishlist.rs`'s order**

Field at `:53` becomes `pub sort: Option<Vec<crate::sorting::SortTerm>>,`. Replace the
`match` at `:365-369` with a whitelist above `list_wishes`:

```rust
/// The columns the wishlist's headers can sort on, plus the two the select offers that have
/// no column.
///
/// **No `set` order, and the Printing column is not a header you can press.** An
/// any-printing wish names no set, and a list where half the rows sort under the same blank
/// is not an order.
///
/// `cost` is what finishing the wish still costs — unit price over the copies *missing*,
/// which is the figure the Cost cell prints and which is zero for a fulfilled wish however
/// dear the card is. `price` is what one copy costs, and stays reachable from the select.
const WISHLIST_SORTS: &[crate::sorting::SortColumn] = &[
    crate::sorting::SortColumn {
        key: "name",
        asc: "w.name ASC",
        desc: "w.name DESC",
    },
    crate::sorting::SortColumn {
        key: "owned",
        asc: "owned_quantity ASC",
        desc: "owned_quantity DESC",
    },
    crate::sorting::SortColumn {
        key: "quantity",
        asc: "w.quantity ASC",
        desc: "w.quantity DESC",
    },
    crate::sorting::SortColumn {
        key: "cost",
        asc: "unit_price_usd * max(0, w.quantity - owned_quantity) ASC NULLS LAST",
        desc: "unit_price_usd * max(0, w.quantity - owned_quantity) DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "price",
        asc: "unit_price_usd ASC NULLS LAST",
        desc: "unit_price_usd DESC NULLS LAST",
    },
    crate::sorting::SortColumn {
        key: "added",
        asc: "w.created_at ASC",
        desc: "w.created_at DESC",
    },
];
```

and the call:

```rust
    let order =
        crate::sorting::order_by(q.sort.as_deref(), WISHLIST_SORTS, "w.name ASC", "w.id ASC");
```

`owned_quantity` is the alias `{OWNED_SQL} AS owned_quantity` already carries in the SELECT
list, and SQLite resolves an alias inside an `ORDER BY` expression. If it does not for the
`cost` expression, inline `OWNED_SQL` there instead with a comment saying why.

- [ ] **Step 4: Run the Rust tests**

```bash
cd src-tauri && cargo test
```

Expected: PASS, with existing `sort: Some("added".into())` tests rewritten as in Task 7.

- [ ] **Step 5: Frontend, exactly as Task 7**

`ipc.ts` line 473 becomes `sort?: SortSpec<WishlistSortKey>;`, with:

```ts
/**
 * The wishlist's sortable columns. There is no `set`: an any-printing wish names no set, so
 * the Printing column is not sortable at all. Mirrors `WISHLIST_SORTS` in
 * `src-tauri/src/wishlist.rs`.
 */
export type WishlistSortKey = "name" | "owned" | "quantity" | "cost" | "price" | "added";
```

`useWishlist.ts` gains the same `sort` / `toggleSort` / `setSortKey` / `sortSelection` shape
as `useCollection`, with:

```ts
const WISHLIST_FIRST_DIR: Record<WishlistSortKey, SortDir> = {
  name: "asc",
  owned: "desc",
  quantity: "desc",
  cost: "desc",
  price: "desc",
  added: "desc",
};
```

`WISHLIST_SORTS` keeps its four options and its `satisfies` clause, retyped to
`WishlistSortKey`. The select in `WishlistFilterBar` gets the same `Custom…` option and the
same `sortSelection` / `setSortKey` wiring, keeping its `ml-auto` and its comment about never
being gold.

`WishlistTable` becomes columns over `VirtualTable`:

| key | width | header | sortable | firstDir |
| --- | --- | --- | --- | --- |
| `name` | (its current track) | Name | yes | asc |
| — | (its current track) | Printing · finish | **no** | — |
| `owned` | (its current track) | Owned | yes | desc |
| `quantity` | (its current track) | Wanted | yes | desc |
| `cost` | (its current track) | Cost | yes | desc |
| `actions` | (its current track) | Actions (`srOnlyHeader`) | no | — |

Read the tracks off the file's existing `GRID` constant in order; do not retype them from
memory. The Printing column keeps `key: "printing"` so it has a React key, and simply omits
`sortable`. The Cost column keeps `headerTitle: PRICES_AS_OF` and
`headerLabel: \`Cost. ${PRICES_AS_OF}\``.

The row wrapper keeps the wishlist's own nullable-`cardId` rule: `onActivate` is passed only
when `row.cardId` is non-null, so pass `onActivate={(row) => row.cardId && selectCard(row.cardId)}`
**and** `rowClassName` returning `undefined` for a row that opens nothing — then set
`tabIndex` correctly by giving `VirtualTable` the row through `renderRow`, where the wishlist
can override `tabIndex` and `onClick` per row exactly as it does today. A row that looked
clickable and did nothing would be worse than one that does not.

- [ ] **Step 6: Run the wishlist tests**

```bash
npx vitest run src/features/wishlist
```

Expected: PASS.

- [ ] **Step 7: Verify and commit**

```bash
npm run verify
git add src/features/wishlist src/lib/ipc.ts src-tauri/src/wishlist.rs
git commit -m "feat(wishlist): sortable headers over the shared table

Four sortable columns; Printing is deliberately not one, because an
any-printing wish names no set. The Cost header sorts by what is still left
to buy, which is the figure the cell prints and is zero for a fulfilled
wish however dear the card is.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 9: The live pass, the CDP modifier, and the docs

The suite cannot see paint order, and this whole plan started with a bug that only paint
order shows.

**Files:**
- Modify: `scripts/cdp.mjs` (`click`, `text`, `press`), `CLAUDE.md`

- [ ] **Step 1: Teach `cdp.mjs` to hold Shift**

Chromium's modifier bitmask is Alt 1, Ctrl 2, Meta 4, **Shift 8**. Add a `--shift` flag to
`click`, `text` and `press`.

In `clickSelector`, take a `modifiers` argument and pass it through:

```js
async function clickSelector(cdp, selector, modifiers = 0) {
  // …existing box lookup…
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp.send("Input.dispatchMouseEvent", {
      type,
      x: box.x,
      y: box.y,
      button: "left",
      clickCount: 1,
      modifiers,
    });
  }
  return box;
}
```

In the command loop, before the `switch`, pull the flag out of `args`:

```js
    // `--shift` on a press or a click, because a multi-key sort is built with one held down
    // and `dispatchEvent` from `eval` proves nothing about what the page really hears.
    const shift = args.includes("--shift");
    args = args.filter((a) => a !== "--shift");
    const modifiers = shift ? 8 : 0;
```

Pass `modifiers` into both `clickSelector` calls, and into `press`'s two
`Input.dispatchKeyEvent` sends. Note in a comment that `press Enter --shift` produces a click
whose `shiftKey` is true, which is the keyboard half of the additive press.

- [ ] **Step 2: Build and launch the app**

The worktree has no Rust target directory; the first build is long.

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```

**Close any other instance first** — `tauri-plugin-single-instance` exits a second copy with
code 0, no window and no stderr, and a dev build from `target/debug` counts.

Read `innerWidth`/`innerHeight` before touching `size`, and end the run with an explicit
`size 1280 800`: `clearDeviceMetricsOverride` restores nothing.

- [ ] **Step 3: Record the console for the whole pass**

In its own shell, and leave it attached:

```bash
node scripts/cdp.mjs console "C:\...\scratchpad\sort-pass.jsonl"
```

A `Log` entry whose `?t=` stamp is frozen at attach time is retained history, not a live
fault.

- [ ] **Step 4: The bug, with a picture**

```bash
node scripts/cdp.mjs eval "document.querySelector('[aria-label=\"Search cards…\"]') && 1"
node scripts/cdp.mjs text "Any set"
node scripts/cdp.mjs shot "C:\...\scratchpad\set-picker-over-header.png"
node scripts/cdp.mjs eval "(() => { const p = document.querySelector('[role=listbox]').closest('div[class*=absolute]').getBoundingClientRect(); const h = document.querySelector('[role=table] [role=row]').getBoundingClientRect(); const y = Math.max(p.top, h.top) + 2; const x = h.left + h.width / 2; return document.elementFromPoint(x, y)?.closest('[role=listbox],[role=row]')?.getAttribute('role'); })()"
```

Expected: the screenshot shows the picker whole, with no grey band across it, and the
hit-test at a point inside **both** rectangles answers `listbox` — the popup is what is
painted there. Before this plan it answered `row`.

- [ ] **Step 5: Sorting, by hand**

```bash
node scripts/cdp.mjs click "[role=table] [role=row]:first-child button[title^='Sort by Price']"
node scripts/cdp.mjs eval "[...document.querySelectorAll('[role=row]')].slice(1,4).map(r => r.children[4].textContent)"
node scripts/cdp.mjs click "[role=table] [role=row]:first-child button[title^='Sort by Rarity']" --shift
node scripts/cdp.mjs eval "[...document.querySelectorAll('[role=row]:first-child [role=columnheader]')].map(h => [h.textContent.trim(), h.getAttribute('aria-sort')])"
node scripts/cdp.mjs shot "C:\...\scratchpad\two-key-sort.png"
```

Expected: prices descend; after the shifted press, two columns report a non-`none`
`aria-sort` and two ordinal badges are drawn.

- [ ] **Step 6: The keyboard, counting activations**

`CLAUDE.md` records a deck stepper that moved 2 → 4 under one reported press. Count.

```bash
node scripts/cdp.mjs eval "window.__sorts = 0; document.addEventListener('click', (e) => { if (e.target.closest('[role=columnheader] button')) window.__sorts++; }, true); 'armed'"
node scripts/cdp.mjs press Enter "[role=table] [role=row]:first-child button[title^='Sort by Name']"
node scripts/cdp.mjs eval "window.__sorts"
node scripts/cdp.mjs press Enter "[role=table] [role=row]:first-child button[title^='Sort by Price']" --shift
node scripts/cdp.mjs eval "[window.__sorts, [...document.querySelectorAll('[role=columnheader][aria-sort]:not([aria-sort=none])')].length]"
```

Expected: `1` after the first press, then `[2, 2]` — two presses, two sorted columns. A `2`
after the first press is the double-activation fault and means the `press` path grew a third
event.

- [ ] **Step 7: The other two tables, and reduced motion**

Repeat Steps 5–6 against the Collection and Wishlist views. Then, in one session because
`setEmulatedMedia` is reverted the instant its socket closes and WebView2 ignores a
features-only override:

```bash
node scripts/cdp.mjs media prefers-reduced-motion reduce "(() => { const b = document.querySelector('[role=columnheader] button'); return getComputedStyle(b).transitionDuration; })()"
```

Expected: `0s`.

- [ ] **Step 8: Record the facts in `CLAUDE.md`**

Add to the **Frontend design (binding)** section:

```markdown
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`, and `src/lib/layers.test.ts` sweeps
  `src/` to keep it the only place they are written.** The bug it closed is worth the
  paragraph: the search view's set picker (`absolute z-20`) was painted over by the results
  table's sticky header (`sticky top-0 z-20`), because nothing between them creates a
  stacking context and **equal z-indexes are resolved by document order** — where every
  table header comes after the filter bar. The part a number cannot fix: a popup inside a
  virtualised row is capped by that row's layer whatever it asks for, because the row is
  `absolute` *and* `transform`ed and is therefore its own stacking context. That is why the
  row lift exists and why it sits *below* the header — a row has to scroll under one.
  Variant spellings (`has-[[aria-expanded=true]]:z-10`) are their own entries, written out:
  Tailwind scans source text for whole class names, so a class built by interpolation emits
  no rule at all.
- **The three tables are one component**, `src/components/table/VirtualTable.tsx`: columns
  are data, and the two things that genuinely differ stay callbacks — `renderRow` (the
  collection and wishlist wrap a row in a drag source) and `extraHeight` (the reconciler's
  flagged band). Its headers are sortable: a press cycles a column, **Shift** keeps the
  other columns so a two- or three-key sort can be built. A header sorts by **what it
  shows** — the collection's Value column by unit × copies, the wishlist's Cost by unit ×
  copies still missing — and the orders with no column ("Recently added", unit price) stay
  on the filter bar's select, which drives the same state and reads `Custom…` when the sort
  starts somewhere it has no option for.
```

And to **Data & sync**, with the Step 1 numbers filled in:

```markdown
- **Sorting the unfiltered browse by an unindexed column costs <N> ms** against the ~10 ms
  the name order costs, measured <date> on the live 116,590-row database. `cards` is indexed
  on `name`, `oracle_id` and `(set_code, collector_number)` only, and no index was added:
  a multi-term sort cannot use one past its leading column, and `schema::swap_staging` drops
  and replays every index on `cards` on each ~93 s sync. <If the two-step page query was
  adopted, say so here and give both figures.>
```

- [ ] **Step 9: Verify, commit, and open the PR**

```bash
npm run verify
git add scripts/cdp.mjs CLAUDE.md
git commit -m "test(table): drive the sortable headers in the real window

cdp.mjs learns --shift, because a multi-key sort is built with one held
down and a dispatchEvent out of eval proves nothing about what the page
hears. Records what the live pass measured, and the layering rule that
started it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"

git push -u origin worktree-table-refac
gh pr create --title "Sortable multi-key table headers, and one layering rule" --body "…"
```

The PR body says: the bug and why equal z-indexes lost to document order; the one
`VirtualTable`; the sort model and the Shift gesture; the two calls (a header sorts by what
it shows; the wishlist's Printing column is not sortable) and the reason the select stays;
the measured sort figures; and what the live CDP pass checked. It ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

---

## Self-Review

**Spec coverage.** §1 layering → Task 1. §2 `VirtualTable` → Task 5, consumed by 6/7/8. §3
model → Task 2; header → Task 5; select → Tasks 7/8; header-sorts-by-what-it-shows → Tasks
7/8; wishlist Printing → Task 8; backend → Tasks 3/4/7/8. §4 measurement → Task 4 Steps 1–2,
6. §5 tests → every task's own steps, plus Task 9 for the live pass. §6 out-of-scope items
appear in no task.

**Type consistency.** `SortSpec`/`SortTerm`/`SortDir`/`applySort`/`sortTermOf`/`sortRankOf`/
`ariaSortOf` are defined in Task 2 and used with those exact names in Tasks 5–8.
`TableColumn`/`VirtualTable`/`TABLE_ROW_HEIGHT`/`TABLE_HEADER_HEIGHT` are defined in Task 5
and used in 6–8. `sorting::{SortTerm, SortColumn, order_by}` is defined in Task 3 and used in
4/7/8. `toggleSort(key, additive)` has the same signature in all three hooks and matches
`VirtualTable`'s `onSort`. The Rust whitelist keys and the TS key unions are listed
side-by-side in Tasks 4/7/8 and match.

**Two things the implementer must not skip:** `LAYER` values are whole class strings
(Tailwind scans text, so interpolation emits nothing), and the search's `ORDER_NAME` loses
its trailing `c.id ASC` to `sorting::order_by` rather than keeping it in both places.
