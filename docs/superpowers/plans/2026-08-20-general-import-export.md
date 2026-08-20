# General Import and Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Any list of cards in this app — a deck, a category, the filtered collection, the filtered wishlist — can be exported in seven formats with the reader choosing which fields the file carries, and any pasted or opened list can be imported into a deck, a new deck, the collection or the wishlist.

**Architecture:** The destination-blind half of today's deck import/export (the modal shell, `parse.ts`, name→printing resolution, the format writers, the file read and write) moves into `src/features/transfer/`. A field registry declares what each *format* can carry and what each *surface* has; the dialog draws the intersection. Import gains an `ImportDestination` interface — a planner plus a preview component — with four implementations.

**Tech Stack:** React 19, TypeScript 6, Vitest + Testing Library, Zustand (`useAppStore`), TanStack Query, Tauri 2.11 / Rust with rusqlite, Storybook 9.

**Spec:** `docs/superpowers/specs/2026-08-20-general-import-export-design.md` — read it before Task 1. Every "why" in this plan is argued there.

## Global Constraints

- **Run `npm run verify` before every commit.** Never two at once across worktrees — concurrent runs fake ~18 Rust schema failures. Never pipe it (`| tail`): the pipe reports tail's exit 0 while tests fail. Redirect to a file and grep the summary.
- **`npm run verify` does not run `cargo fmt` or `cargo clippy`; CI does.** Any task touching Rust ends with `cargo fmt` and `cargo clippy --all-targets -- -D warnings` in `src-tauri/`. Clippy caps a function at 7 arguments.
- **This worktree needs its own `npm install`** before any suite passes — without it three suites fail on Vite's `fs.allow` and it reads as your regression.
- **Never install `@types/node`.** Its absence is the only fence keeping Node types out of the app program.
- **Bulk renames must not use PowerShell `-replace`** — it is case-insensitive and will shout every string literal. Use `.Replace()` from a `.mjs` file run with `node`.
- **`src/lib/ipc.ts` is a hand-written mirror of the Rust structs.** Nothing type-checks it against the crate; every command rename is a two-sided edit plus the Storybook fake in `.storybook/fake/db.ts`.
- **`.storybook/fake/db.ts` and `docs/reference/decks-storage.md` are seen as binary by ripgrep.** Grep returning "no matches" there is a lie — use `Read` or `Select-String`.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts`** and nowhere else.
- **Every modal is built on the shared dialog shell**, never beside it. jsdom has no layout engine, so a modal's clamping cannot go red in the suite — check a changed modal in the running window at a short viewport.
- **Commit messages**: `feat:` / `fix:` / `chore:` / `test:` / `docs:` / `refactor:`. Commit small, after each task.
- **`data/` is the user's and is never committed.**

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/components/Dialog.tsx` | The modal shell (was `features/decks/DeckDialog.tsx`) |
| `src/features/transfer/formats.ts` | Format identity: the seven names, labels, extensions |
| `src/features/transfer/fields.ts` | The field registry, per-format and per-surface declarations, the intersection rule |
| `src/features/transfer/TransferCard.ts` | The one card shape, and the three surface adapters |
| `src/features/transfer/csv.ts` | RFC 4180 writer and reader |
| `src/features/transfer/export/fold.ts` | `foldForFields` — merging rows a field set cannot tell apart |
| `src/features/transfer/export/format.ts` | The seven writers, composed from a field set |
| `src/features/transfer/export/ExportDialog.tsx` | The generic export dialog |
| `src/features/transfer/export/scope.ts` | A filter becomes a whole list (the paged sweep) |
| `src/features/transfer/import/parse.ts` | Text → lines; unchanged rules plus a CSV arm |
| `src/features/transfer/import/ImportDialog.tsx` | The generic import shell |
| `src/features/transfer/import/useImport.ts` | Resolve, read-file, and the four commits |
| `src/features/transfer/import/destinations/*.ts(x)` | One planner + one preview per destination |
| `src-tauri/src/import.rs` | `import_resolve`, `deck_import_commit`, `import_read_file` |
| `src-tauri/src/collection.rs` | `+ collection_import_commit` |
| `src-tauri/src/wishlist.rs` | `+ wishlist_import_commit` |

**Deviation from the spec worth naming:** the spec's §2 layout puts format identity inside `export/format.ts`. This plan splits `formats.ts` out at the module root because `fields.ts` declares capabilities *per format* and `format.ts` consumes `fields.ts` — leaving the format list in `format.ts` would make that a cycle.

---

### Task 1: Promote the modal shell out of the deck surface

`src/features/decks/DeckDialog.tsx` imports only from `src/lib/` and is already borrowed across a feature boundary by `src/features/card/AllPrintingsDialog.tsx`. It moves with no behaviour change.

**Files:**
- Move: `src/features/decks/DeckDialog.tsx` → `src/components/Dialog.tsx`
- Move: `src/features/decks/DeckDialog.test.tsx` → `src/components/Dialog.test.tsx`
- Move: `src/features/decks/DeckDialog.stories.tsx` → `src/components/Dialog.stories.tsx`
- Modify: every importer (about ten files — the list comes from step 1)
- Modify: `src/CLAUDE.md`, `src/features/decks/CLAUDE.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `Dialog`, `DialogProps`, `DialogFlanks` from `@/components/Dialog`. Prop names are unchanged: `open`, `title`, `ariaLabel?`, `subtitle?`, `closeLabel`, `width`, `flanks?`, `onPanelKeyDown?`, `onDismiss`, `onClose`, `children`.

- [ ] **Step 1: List every importer, so the rename is complete rather than nearly complete**

Run: `npx rg -l "DeckDialog" src/ .storybook/ docs/`

Expected: about 25 files, of which ~10 are real importers and the rest are prose and test assertions. Keep this list; it is the checklist for step 4.

- [ ] **Step 2: Move the three files with git, preserving history**

```bash
git mv src/features/decks/DeckDialog.tsx src/components/Dialog.tsx
git mv src/features/decks/DeckDialog.test.tsx src/components/Dialog.test.tsx
git mv src/features/decks/DeckDialog.stories.tsx src/components/Dialog.stories.tsx
```

- [ ] **Step 3: Write the rename script**

PowerShell's `-replace` is case-insensitive and would rewrite `deckDialog` and `DECKDIALOG` alike. Use Node.

Create `scripts/rename-dialog.mjs`:

```js
import { readFileSync, writeFileSync } from "node:fs";

const files = process.argv.slice(2);
const pairs = [
  ["DeckDialogFlanks", "DialogFlanks"],
  ["DeckDialogProps", "DialogProps"],
  ["DeckDialog", "Dialog"],
  ['from "../DeckDialog"', 'from "@/components/Dialog"'],
  ['from "./DeckDialog"', 'from "@/components/Dialog"'],
  ['from "@/features/decks/DeckDialog"', 'from "@/components/Dialog"'],
];

for (const file of files) {
  let text = readFileSync(file, "utf8");
  for (const [from, to] of pairs) text = text.split(from).join(to);
  writeFileSync(file, text);
}
```

Order matters: the longest names first, or `DeckDialogProps` becomes `DialogProps` only by accident of `DeckDialog` running first and leaving `DialogProps` — which happens to be right here, but is not a property to rely on.

- [ ] **Step 4: Run it over the importers**

```bash
node scripts/rename-dialog.mjs $(npx rg -l "DeckDialog" src/ | tr '\n' ' ')
```

Then fix the three moved files' own relative imports by hand: `src/components/Dialog.tsx` imports from `@/lib/…` already and needs no change; the test and the stories now import `./Dialog`.

- [ ] **Step 5: Fix the prose**

`src/CLAUDE.md` and `src/features/decks/CLAUDE.md` both name `src/features/decks/DeckDialog.tsx` as the one definition of a modal. Update both paths to `src/components/Dialog.tsx`. Do not change the surrounding argument — the rule is unchanged, only its address.

- [ ] **Step 6: Verify**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: all suites pass, no TypeScript errors. If `stories.test.tsx` fails, a story file's path changed and its title did not — fix the title.

- [ ] **Step 7: Commit**

```bash
rm scripts/rename-dialog.mjs verify.log
git add -A
git commit -m "refactor: promote DeckDialog to components/Dialog"
```

---

### Task 2: Move the import and export folders into `features/transfer/`

Pure move. No behaviour change, no rename of any exported symbol except the dialog import fixed in Task 1.

**Files:**
- Move: `src/features/decks/export/` → `src/features/transfer/export/`
- Move: `src/features/decks/import/` → `src/features/transfer/import/`
- Move: `src/features/decks/decklists.test.ts` → `src/features/transfer/decklists.test.ts`
- Modify: `src/features/decks/DeckEditor.tsx`, `src/features/decks/DecksPage.tsx`, `src/features/decks/categoryMenu.tsx` and any other importer
- Modify: `src/features/decks/CLAUDE.md` (its Import section moves), create `src/features/transfer/CLAUDE.md`

**Interfaces:**
- Consumes: `@/components/Dialog` from Task 1.
- Produces: every existing symbol at a new path — `@/features/transfer/export/format`, `@/features/transfer/import/parse`, `@/features/transfer/import/plan`, `@/features/transfer/import/useDeckImport`, `@/features/transfer/export/ExportDialog`, `@/features/transfer/import/ImportDeckDialog`.

- [ ] **Step 1: Move the folders**

```bash
mkdir -p src/features/transfer
git mv src/features/decks/export src/features/transfer/export
git mv src/features/decks/import src/features/transfer/import
git mv src/features/decks/decklists.test.ts src/features/transfer/decklists.test.ts
```

- [ ] **Step 2: Repoint the relative imports that just broke**

The moved files reach back into `features/decks/` with `../`. Every one becomes an absolute alias. In `src/features/transfer/import/plan.ts`:

```ts
import { AUTO_CATEGORY_DISPLAY_ORDER, PREDEFINED_CATEGORY_NAMES, UNCATEGORIZED, autoCategoryFor } from "@/features/decks/autoCategory";
import { commanderIneligibility } from "@/features/decks/validation/commanders";
import type { CardIdentity } from "@/features/decks/validation/types";
```

In `src/features/transfer/import/useDeckImport.ts`:

```ts
import { DEFAULT_VARIANT } from "@/features/decks/useDeck";
```

In `src/features/transfer/import/ImportDeckDialog.tsx`:

```ts
import { DEFAULT_FORMAT, FormatSelect, GameSelect } from "@/features/decks/FormatSelect";
import { DEFAULT_VARIANT, useDeck } from "@/features/decks/useDeck";
import { ANY_GAME, useFormatSpecs } from "@/features/decks/useFormatSpecs";
```

In `src/features/transfer/decklists.test.ts`, the three imports that were `./export/format`, `./import/fixtures`, `./import/parse`, `./import/plan` keep those relative paths — the file moved with them.

- [ ] **Step 3: Repoint the importers left behind in `features/decks/`**

Run: `npx rg -n "decks/(import|export)/|from \"\./(import|export)/" src/`

Rewrite each hit to `@/features/transfer/…`. `DeckEditor.tsx` is the main one (it imports `ExportDialog` and `ImportDeckDialog`); `categoryMenu.tsx` opens the category export.

- [ ] **Step 4: Verify**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: green. A red `stories.test.tsx` means a story `title` still says `Decks/…` for a file that moved — fix the titles to `Transfer/…`.

- [ ] **Step 5: Move the prose**

Create `src/features/transfer/CLAUDE.md` and move the Import section out of `src/features/decks/CLAUDE.md` into it verbatim, changing only paths. Leave a one-line pointer in the decks file: `**Import and export live in [`src/features/transfer/`](../transfer/CLAUDE.md).**`

- [ ] **Step 6: Commit**

```bash
rm verify.log
git add -A
git commit -m "refactor: move import and export into features/transfer"
```

---

### Task 3: Rename the Rust module and its two destination-blind commands

**Files:**
- Move: `src-tauri/src/deck_import.rs` → `src-tauri/src/import.rs`
- Modify: `src-tauri/src/lib.rs` (module declaration and the handler list)
- Modify: `src/lib/ipc.ts`
- Modify: `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`
- Modify: any Rust or TS test naming the old commands

**Interfaces:**
- Consumes: nothing.
- Produces: Tauri commands `import_resolve(lines)`, `import_read_file(path)`, and the unchanged `deck_import_commit(deckId, variant, mode, items)`. In `ipc.ts`: `ipc.importResolve(lines)`, `ipc.importReadFile(path)`, `ipc.deckImportCommit(...)`.

- [ ] **Step 1: Move the file and rename the module**

```bash
git mv src-tauri/src/deck_import.rs src-tauri/src/import.rs
```

In `src-tauri/src/lib.rs`, `pub mod deck_import;` becomes `pub mod import;`, and the three handler entries become:

```rust
            import::import_resolve,
            import::deck_import_commit,
            import::import_read_file,
```

- [ ] **Step 2: Rename the two commands in Rust**

In `src-tauri/src/import.rs`, `pub async fn deck_import_resolve` → `pub async fn import_resolve`, and `pub async fn deck_import_read_file` → `pub async fn import_read_file`. Then fix every `crate::deck_import::` path across the crate:

Run: `npx rg -n "deck_import" src-tauri/src/`

Rewrite `crate::deck_import::deck_import_read_file` (referenced in `export.rs`'s doc comment) to `crate::import::import_read_file`, and every other `deck_import::` to `import::`. `deck_import_commit` keeps its own name throughout.

**Do not do this with a blind substring replace of `deck_import` → `import`.** `deck_import_commit`
contains `deck_import`, and that name must survive this task intact — a naive pass renames it to
`import_commit` in Rust, in `lib.rs`'s handler list, in `ipc.ts` and in the Storybook fake, and the
command then no longer exists under the name the frontend invokes. Nothing type-checks `ipc.ts`
against the crate, so the failure surfaces at runtime as a deck import that refuses with "command
not found" rather than as a red build. Task 1 hit the same class of bug — `CreateDeckDialog`
contains `DeckDialog` — so rename by **whole identifier**, matching the three exact names
`deck_import_resolve`, `deck_import_read_file` and the module path `deck_import::`, and leave every
other occurrence alone. After the rename, `rg -n "deck_import" .` must show `deck_import_commit`
and nothing else.

- [ ] **Step 3: Rename the mirror**

In `src/lib/ipc.ts`:

```ts
  importResolve: (lines: ImportResolveLine[]) =>
    invoke<ImportResolveRow[]>("import_resolve", { lines }),
  importReadFile: (path: string) => invoke<string>("import_read_file", { path }),
```

Then fix the callers: `src/features/transfer/import/useDeckImport.ts` calls `ipc.deckImportResolve` and `ipc.deckImportReadFile`.

- [ ] **Step 4: Rename the fake's handler keys**

In `.storybook/fake/db.ts`, the read handler `deck_import_resolve` becomes `import_resolve` (around line 3777). Add `import_read_file` if the fake has one; if it does not, leave it — the dialog's file picker is unreachable in Storybook. In `.storybook/fake/db.test.ts`, the two references to `deck_import_resolve` become `import_resolve`.

- [ ] **Step 5: Verify both sides**

```bash
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
```

Expected: green, and no clippy warnings. Then confirm nothing was missed:

Run: `npx rg -n "deck_import_resolve|deck_import_read_file|deckImportResolve|deckImportReadFile" .`

Expected: no hits.

- [ ] **Step 6: Commit**

```bash
rm verify.log
git add -A
git commit -m "refactor: rename deck_import to import and its two destination-blind commands"
```

---

### Task 4: `TransferCard` and the three surface adapters

**Files:**
- Create: `src/features/transfer/TransferCard.ts`
- Create: `src/features/transfer/TransferCard.test.ts`

**Interfaces:**
- Consumes: `DeckCard`, `CollectionRow`, `WishRow`, `DeckFinish`, `CategoryKind` from `@/lib/ipc`.
- Produces: `TransferCard`, `fromDeckCard(card: DeckCard): TransferCard`, `fromCollectionRow(row: CollectionRow): TransferCard`, `fromWishRow(row: WishRow): TransferCard`.

- [ ] **Step 1: Write the failing test**

Create `src/features/transfer/TransferCard.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CollectionRow, DeckCard, WishRow } from "@/lib/ipc";
import { fromCollectionRow, fromDeckCard, fromWishRow } from "./TransferCard";

describe("fromDeckCard", () => {
  it("carries the three category facts and leaves the collection's fields null", () => {
    const card = { name: "Sol Ring", quantity: 2, setCode: "LTC", collectorNumber: "285",
      finish: "foil", lang: "en", categoryName: "Ramp", categoryKind: "main",
      categoryActive: true, setName: "Commander Masters", rarity: "uncommon",
      typeLine: "Artifact", unitPrice: 1.5 } as unknown as DeckCard;

    const t = fromDeckCard(card);

    expect(t).toMatchObject({ name: "Sol Ring", quantity: 2, categoryName: "Ramp",
      categoryKind: "main", categoryActive: true });
    // A deck does not record a condition. `null` is "this surface has no such fact",
    // which is what `availableFields` reads.
    expect(t.condition).toBeNull();
    expect(t.purchasePrice).toBeNull();
  });
});

describe("fromCollectionRow", () => {
  it("carries condition and acquisition, and has no category at all", () => {
    const row = { name: "Sol Ring", quantity: 3, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil", lang: "en", condition: "LP", tradelistQuantity: 1,
      purchasePrice: 2.5, purchaseCurrency: "USD", acquiredAt: "2026-01-02",
      acquisitionSource: "LGS", serialNumber: null, grading: null, altered: false,
      signed: false, proxy: false, misprint: false, tags: "[]", notes: "box 3",
      setName: "Commander Masters", rarity: "uncommon", typeLine: "Artifact",
      unitPrice: 1.5 } as unknown as CollectionRow;

    const t = fromCollectionRow(row);

    expect(t).toMatchObject({ condition: "LP", purchasePrice: 2.5, notes: "box 3" });
    expect(t.categoryName).toBeNull();
    expect(t.categoryKind).toBeNull();
  });

  it("reads `nonfoil` as the regular copy, which is null everywhere else in this app", () => {
    const row = { name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      finish: "nonfoil" } as unknown as CollectionRow;
    expect(fromCollectionRow(row).finish).toBeNull();
  });
});

describe("fromWishRow", () => {
  it("has no set name, because a wishlist row does not carry one", () => {
    const row = { name: "Sol Ring", quantity: 1, setCode: "LTC", collectorNumber: "285",
      preferredFinish: null, lang: "en", notes: null, unitPrice: 1.5, rarity: "uncommon",
      typeLine: "Artifact" } as unknown as WishRow;

    const t = fromWishRow(row);

    expect(t.setName).toBeNull();
    expect(t.finish).toBeNull();
    expect(t.condition).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/TransferCard.test.ts`

Expected: FAIL — `Failed to resolve import "./TransferCard"`.

- [ ] **Step 3: Write `TransferCard.ts`**

```ts
/**
 * The one card shape both halves of a transfer speak.
 *
 * **`null` means this surface does not have this fact, never "empty".** That distinction is what
 * `availableFields` reads to decide a checkbox does not exist: a deck has no condition, so a
 * deck's rows carry `condition: null` and the Condition box never draws — rather than drawing
 * over a column of blanks.
 */
import type { CategoryKind, CollectionRow, DeckCard, DeckFinish, WishRow } from "@/lib/ipc";

export interface TransferCard {
  name: string;
  quantity: number;
  setCode: string | null;
  collectorNumber: string | null;
  finish: DeckFinish;
  lang: string | null;
  categoryName: string | null;
  categoryKind: CategoryKind | null;
  categoryActive: boolean | null;
  condition: string | null;
  tradelistQuantity: number | null;
  purchasePrice: number | null;
  purchaseCurrency: string | null;
  acquiredAt: string | null;
  acquisitionSource: string | null;
  serialNumber: string | null;
  grading: string | null;
  altered: boolean | null;
  signed: boolean | null;
  proxy: boolean | null;
  misprint: boolean | null;
  tags: string | null;
  notes: string | null;
  setName: string | null;
  rarity: string | null;
  typeLine: string | null;
  unitPrice: number | null;
}

/** Every field a surface does not have, in one object to spread. */
const NOTHING = {
  setCode: null, collectorNumber: null, finish: null, lang: null,
  categoryName: null, categoryKind: null, categoryActive: null,
  condition: null, tradelistQuantity: null, purchasePrice: null, purchaseCurrency: null,
  acquiredAt: null, acquisitionSource: null, serialNumber: null, grading: null,
  altered: null, signed: null, proxy: null, misprint: null, tags: null, notes: null,
  setName: null, rarity: null, typeLine: null, unitPrice: null,
} satisfies Omit<TransferCard, "name" | "quantity">;

/**
 * `'nonfoil'` is the collection's spelling of the regular copy; `null` is everyone else's.
 * Two spellings of one finish would fold as two rows in `foldForFields` and write two lines
 * naming the same card.
 */
function finishOf(raw: string | null | undefined): DeckFinish {
  if (raw === "foil") return "foil";
  if (raw === "etched") return "etched";
  return null;
}

export function fromDeckCard(card: DeckCard): TransferCard {
  return {
    ...NOTHING,
    name: card.name,
    quantity: card.quantity,
    setCode: card.setCode,
    collectorNumber: card.collectorNumber,
    finish: card.finish,
    lang: card.lang,
    categoryName: card.categoryName,
    categoryKind: card.categoryKind,
    categoryActive: card.categoryActive,
    setName: card.setName,
    rarity: card.rarity ?? null,
    typeLine: card.typeLine ?? null,
    unitPrice: card.unitPrice ?? null,
  };
}

export function fromCollectionRow(row: CollectionRow): TransferCard {
  return {
    ...NOTHING,
    name: row.name ?? "",
    quantity: row.quantity,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    finish: finishOf(row.finish),
    lang: row.lang,
    condition: row.condition,
    tradelistQuantity: row.tradelistQuantity,
    purchasePrice: row.purchasePrice,
    purchaseCurrency: row.purchaseCurrency,
    acquiredAt: row.acquiredAt,
    acquisitionSource: row.acquisitionSource,
    serialNumber: row.serialNumber,
    grading: row.grading,
    altered: row.altered,
    signed: row.signed,
    proxy: row.proxy,
    misprint: row.misprint,
    tags: row.tags,
    notes: row.notes,
    setName: row.setName,
    rarity: row.rarity,
    typeLine: row.typeLine,
    unitPrice: row.unitPrice,
  };
}

export function fromWishRow(row: WishRow): TransferCard {
  return {
    ...NOTHING,
    name: row.name,
    quantity: row.quantity,
    setCode: row.setCode,
    collectorNumber: row.collectorNumber,
    finish: finishOf(row.preferredFinish),
    lang: row.lang,
    notes: row.notes,
    rarity: row.rarity,
    typeLine: row.typeLine,
    unitPrice: row.unitPrice,
  };
}
```

`DeckCard` carries `rarity`, `typeLine` and `unitPrice` — verified in `src/lib/ipc.ts`. Keep all three; `SURFACE_FIELDS.deck` in Task 5 lists them for this reason.

- [ ] **Step 4: Run the test**

Run: `npm run test:run -- src/features/transfer/TransferCard.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/transfer/TransferCard.ts src/features/transfer/TransferCard.test.ts
git commit -m "feat(transfer): one card shape for every surface"
```

---

### Task 5: The field registry and the intersection rule

**Files:**
- Create: `src/features/transfer/formats.ts`
- Create: `src/features/transfer/fields.ts`
- Create: `src/features/transfer/fields.test.ts`
- Modify: `src/features/transfer/export/format.ts` (re-export the three format constants from `formats.ts` so nothing breaks yet)

**Interfaces:**
- Consumes: `TransferCard` from Task 4.
- Produces:
  - `formats.ts`: `EXPORT_FORMATS`, `ExportFormat`, `EXPORT_FORMAT_LABEL`, `EXPORT_FORMAT_EXTENSION`.
  - `fields.ts`: `TRANSFER_FIELD_IDS`, `TransferFieldId`, `TransferField`, `TRANSFER_FIELDS`, `ALWAYS`, `TransferSurface` (`"deck" | "collection" | "wishlist"`), `availableFields(format, surface): TransferFieldId[]`, `defaultFields(format, surface): TransferFieldId[]`.

- [ ] **Step 1: Write the failing test**

Create `src/features/transfer/fields.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { availableFields, defaultFields, TRANSFER_FIELD_IDS, TRANSFER_FIELDS } from "./fields";
import { EXPORT_FORMATS } from "./formats";

describe("availableFields", () => {
  it("is the intersection of what the format can carry and what the surface has", () => {
    // Archidekt has a bracket for a pile; a wishlist has no piles.
    expect(availableFields("archidekt", "deck")).toContain("category");
    expect(availableFields("archidekt", "wishlist")).not.toContain("category");
  });

  it("offers no finish where the format has nowhere to put one", () => {
    // Arena's line is `1 Sol Ring (LTC) 285` and nothing else.
    expect(availableFields("arena", "deck")).not.toContain("finish");
    expect(availableFields("moxfield", "deck")).toContain("finish");
  });

  it("offers the collection's own fields in CSV and in nothing else", () => {
    expect(availableFields("csv", "collection")).toContain("purchasePrice");
    expect(availableFields("plain", "collection")).not.toContain("purchasePrice");
  });

  it("always offers quantity and name, in every format on every surface", () => {
    for (const format of EXPORT_FORMATS) {
      for (const surface of ["deck", "collection", "wishlist"] as const) {
        expect(availableFields(format, surface)).toEqual(
          expect.arrayContaining(["quantity", "name"]),
        );
      }
    }
  });

  it("answers in registry order, so a CSV's columns are stable", () => {
    const fields = availableFields("csv", "collection");
    const positions = fields.map((f) => TRANSFER_FIELD_IDS.indexOf(f));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });
});

describe("defaultFields", () => {
  it("reproduces today's deck CSV columns exactly", () => {
    expect(defaultFields("csv", "deck")).toEqual([
      "quantity", "name", "setCode", "collectorNumber", "category", "finish",
    ]);
  });

  it("drops the category on a surface that has none and keeps condition where there is one", () => {
    expect(defaultFields("csv", "collection")).toEqual([
      "quantity", "name", "setCode", "collectorNumber", "finish", "condition",
    ]);
  });

  it("is a subset of what is available, in every pair", () => {
    for (const format of EXPORT_FORMATS) {
      for (const surface of ["deck", "collection", "wishlist"] as const) {
        const available = availableFields(format, surface);
        for (const id of defaultFields(format, surface)) expect(available).toContain(id);
      }
    }
  });
});

describe("TRANSFER_FIELDS", () => {
  it("names every id exactly once, with a unique CSV header", () => {
    const headers = TRANSFER_FIELD_IDS.map((id) => TRANSFER_FIELDS[id].csvHeader.toLowerCase());
    expect(new Set(headers).size).toBe(TRANSFER_FIELD_IDS.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/fields.test.ts`

Expected: FAIL — cannot resolve `./fields`.

- [ ] **Step 3: Write `formats.ts`**

Move the three constants out of `export/format.ts` verbatim — the list, the labels, the extensions, and the `ExportFormat` type. Then in `export/format.ts` replace those declarations with:

```ts
export {
  EXPORT_FORMATS,
  EXPORT_FORMAT_LABEL,
  EXPORT_FORMAT_EXTENSION,
  type ExportFormat,
} from "../formats";
```

so every existing importer keeps working until Task 8 moves them.

- [ ] **Step 4: Write `fields.ts`**

```ts
/**
 * What a file can say about a card, and who can say it.
 *
 * **Two independent declarations, and the dialog draws their intersection.** A *format* says
 * what channels it has — Arena's line has nowhere to put a finish, so Arena does not offer one.
 * A *surface* says what facts it holds — a wishlist has no piles, so no wishlist export offers a
 * category. Neither declaration knows about the other, which is what stops this becoming a
 * per-surface list of things to remember to hide.
 */
import type { ExportFormat } from "./formats";
import type { TransferCard } from "./TransferCard";

/**
 * Every field, **in the order a CSV writes its columns**. The first six are today's deck CSV
 * header, spelled in today's order, which is what makes `defaultFields("csv", "deck")` a
 * byte-for-byte reproduction of what shipped.
 */
export const TRANSFER_FIELD_IDS = [
  "quantity",
  "name",
  "setCode",
  "collectorNumber",
  "category",
  "finish",
  "condition",
  "lang",
  "tradelistQuantity",
  "purchasePrice",
  "purchaseCurrency",
  "acquiredAt",
  "acquisitionSource",
  "serialNumber",
  "grading",
  "altered",
  "signed",
  "proxy",
  "misprint",
  "tags",
  "notes",
  "setName",
  "rarity",
  "typeLine",
  "unitPrice",
] as const;
export type TransferFieldId = (typeof TRANSFER_FIELD_IDS)[number];

export interface TransferField {
  /** The checkbox's word. */
  label: string;
  /** The CSV column name — and what the CSV *reader* matches an incoming header against. */
  csvHeader: string;
  /** `""` when this card has nothing to say, which is what an empty cell means. */
  read(card: TransferCard): string;
}

const flag = (v: boolean | null): string => (v === true ? "yes" : v === false ? "no" : "");
const num = (v: number | null): string => (v === null ? "" : String(v));

export const TRANSFER_FIELDS: Record<TransferFieldId, TransferField> = {
  quantity: { label: "Quantity", csvHeader: "Quantity", read: (c) => String(c.quantity) },
  name: { label: "Name", csvHeader: "Name", read: (c) => c.name },
  setCode: { label: "Set code", csvHeader: "Set", read: (c) => c.setCode ?? "" },
  collectorNumber: {
    label: "Collector number",
    csvHeader: "Collector number",
    read: (c) => c.collectorNumber ?? "",
  },
  category: { label: "Category", csvHeader: "Category", read: (c) => c.categoryName ?? "" },
  // The word rather than the letter: a column somebody opens in a spreadsheet should say `foil`.
  finish: { label: "Finish", csvHeader: "Finish", read: (c) => c.finish ?? "" },
  condition: { label: "Condition", csvHeader: "Condition", read: (c) => c.condition ?? "" },
  lang: { label: "Language", csvHeader: "Language", read: (c) => c.lang ?? "" },
  tradelistQuantity: {
    label: "Tradelist quantity",
    csvHeader: "Tradelist quantity",
    read: (c) => num(c.tradelistQuantity),
  },
  purchasePrice: {
    label: "Purchase price",
    csvHeader: "Purchase price",
    read: (c) => num(c.purchasePrice),
  },
  purchaseCurrency: {
    label: "Purchase currency",
    csvHeader: "Purchase currency",
    read: (c) => c.purchaseCurrency ?? "",
  },
  acquiredAt: { label: "Acquired", csvHeader: "Acquired", read: (c) => c.acquiredAt ?? "" },
  acquisitionSource: {
    label: "Acquired from",
    csvHeader: "Acquired from",
    read: (c) => c.acquisitionSource ?? "",
  },
  serialNumber: {
    label: "Serial number",
    csvHeader: "Serial number",
    read: (c) => c.serialNumber ?? "",
  },
  grading: { label: "Grading", csvHeader: "Grading", read: (c) => c.grading ?? "" },
  altered: { label: "Altered", csvHeader: "Altered", read: (c) => flag(c.altered) },
  signed: { label: "Signed", csvHeader: "Signed", read: (c) => flag(c.signed) },
  proxy: { label: "Proxy", csvHeader: "Proxy", read: (c) => flag(c.proxy) },
  misprint: { label: "Misprint", csvHeader: "Misprint", read: (c) => flag(c.misprint) },
  tags: { label: "Tags", csvHeader: "Tags", read: (c) => c.tags ?? "" },
  notes: { label: "Notes", csvHeader: "Notes", read: (c) => c.notes ?? "" },
  setName: { label: "Set name", csvHeader: "Set name", read: (c) => c.setName ?? "" },
  rarity: { label: "Rarity", csvHeader: "Rarity", read: (c) => c.rarity ?? "" },
  typeLine: { label: "Type line", csvHeader: "Type line", read: (c) => c.typeLine ?? "" },
  unitPrice: { label: "Price", csvHeader: "Price", read: (c) => num(c.unitPrice) },
};

/** What no format may omit. A line with no count and no name is not a card. */
export const ALWAYS: readonly TransferFieldId[] = ["quantity", "name"];

interface FormatFields {
  /** What the reader may toggle. `always` is implicit and never listed here. */
  optional: readonly TransferFieldId[];
  /** What is on when the dialog opens — chosen to reproduce today's output byte for byte. */
  defaultOn: readonly TransferFieldId[];
}

const PRINTING: readonly TransferFieldId[] = ["setCode", "collectorNumber"];

export const FORMAT_FIELDS: Record<ExportFormat, FormatFields> = {
  plain: { optional: ["finish"], defaultOn: ["finish"] },
  // MTGO's `SB:` is structure, not a field, and the format says nothing else about a card.
  mtgo: { optional: [], defaultOn: [] },
  arena: { optional: PRINTING, defaultOn: PRINTING },
  moxfield: { optional: [...PRINTING, "finish"], defaultOn: [...PRINTING, "finish"] },
  archidekt: {
    optional: [...PRINTING, "finish", "category"],
    defaultOn: [...PRINTING, "finish", "category"],
  },
  tcgplayer: { optional: PRINTING, defaultOn: PRINTING },
  // Everything, and the surface is what narrows it. `condition` is in the defaults so a
  // collection CSV separates a NM copy from an LP one without the reader having to know that
  // is what makes them two rows; on a deck it is not available and drops out.
  csv: {
    optional: TRANSFER_FIELD_IDS,
    defaultOn: [...PRINTING, "category", "finish", "condition"],
  },
};

export type TransferSurface = "deck" | "collection" | "wishlist";

export const SURFACE_FIELDS: Record<TransferSurface, readonly TransferFieldId[]> = {
  deck: [
    "quantity", "name", "setCode", "collectorNumber", "category", "finish", "lang",
    "setName", "rarity", "typeLine", "unitPrice",
  ],
  collection: [
    "quantity", "name", "setCode", "collectorNumber", "finish", "condition", "lang",
    "tradelistQuantity", "purchasePrice", "purchaseCurrency", "acquiredAt",
    "acquisitionSource", "serialNumber", "grading", "altered", "signed", "proxy",
    "misprint", "tags", "notes", "setName", "rarity", "typeLine", "unitPrice",
  ],
  // No `setName`: a `WishRow` carries a set code and nothing about the set.
  wishlist: [
    "quantity", "name", "setCode", "collectorNumber", "finish", "lang", "notes",
    "rarity", "typeLine", "unitPrice",
  ],
};

/** The intersection, in registry order — which is what makes a CSV's columns stable. */
export function availableFields(
  format: ExportFormat,
  surface: TransferSurface,
): TransferFieldId[] {
  const offered = new Set<TransferFieldId>([...ALWAYS, ...FORMAT_FIELDS[format].optional]);
  const held = new Set<TransferFieldId>(SURFACE_FIELDS[surface]);
  return TRANSFER_FIELD_IDS.filter((id) => offered.has(id) && held.has(id));
}

/** What is on when the dialog opens: the format's defaults, narrowed to what the surface has. */
export function defaultFields(
  format: ExportFormat,
  surface: TransferSurface,
): TransferFieldId[] {
  const on = new Set<TransferFieldId>([...ALWAYS, ...FORMAT_FIELDS[format].defaultOn]);
  return availableFields(format, surface).filter((id) => on.has(id));
}
```

- [ ] **Step 5: Run the test**

Run: `npm run test:run -- src/features/transfer/fields.test.ts`

Expected: PASS, 8 tests.

- [ ] **Step 6: Verify nothing else moved**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: green — `export/format.ts` re-exports the three constants, so its importers are untouched.

- [ ] **Step 7: Commit**

```bash
rm verify.log
git add -A
git commit -m "feat(transfer): a field registry whose format and surface declarations intersect"
```

---

### Task 6: `foldForFields` — rows a field set cannot tell apart become one

A collection holds 2 NM + 1 LP Lightning Bolt as two rows. A plain-text export has no condition channel, so it must write `3 Lightning Bolt` — not three lines naming one card.

**Files:**
- Create: `src/features/transfer/export/fold.ts`
- Create: `src/features/transfer/export/fold.test.ts`

**Interfaces:**
- Consumes: `TransferCard` (Task 4), `TransferFieldId`, `TRANSFER_FIELDS` (Task 5).
- Produces: `foldForFields(cards: readonly TransferCard[], fields: readonly TransferFieldId[]): TransferCard[]`.

- [ ] **Step 1: Write the failing test**

Create `src/features/transfer/export/fold.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { TransferCard } from "../TransferCard";
import { foldForFields } from "./fold";

const card = (over: Partial<TransferCard> = {}): TransferCard =>
  ({
    name: "Lightning Bolt", quantity: 1, setCode: "LEA", collectorNumber: "161",
    finish: null, lang: "en", categoryName: null, categoryKind: null, categoryActive: null,
    condition: null, tradelistQuantity: null, purchasePrice: null, purchaseCurrency: null,
    acquiredAt: null, acquisitionSource: null, serialNumber: null, grading: null,
    altered: null, signed: null, proxy: null, misprint: null, tags: null, notes: null,
    setName: null, rarity: null, typeLine: null, unitPrice: null,
    ...over,
  }) satisfies TransferCard;

describe("foldForFields", () => {
  it("sums two rows the chosen fields cannot tell apart", () => {
    const rows = [card({ quantity: 2, condition: "NM" }), card({ quantity: 1, condition: "LP" })];
    const folded = foldForFields(rows, ["quantity", "name"]);
    expect(folded).toHaveLength(1);
    expect(folded[0].quantity).toBe(3);
  });

  it("keeps them apart the moment the file can say why they are two", () => {
    const rows = [card({ quantity: 2, condition: "NM" }), card({ quantity: 1, condition: "LP" })];
    const folded = foldForFields(rows, ["quantity", "name", "condition"]);
    expect(folded).toHaveLength(2);
    expect(folded.map((c) => c.quantity)).toEqual([2, 1]);
  });

  it("never folds a foil into a regular copy when the finish is written", () => {
    const rows = [card({ quantity: 1, finish: "foil" }), card({ quantity: 1, finish: null })];
    expect(foldForFields(rows, ["quantity", "name", "finish"])).toHaveLength(2);
  });

  it("keeps first-appearance order, because the caller's order is the file's order", () => {
    const rows = [card({ name: "Sol Ring" }), card({ name: "Arcane Signet" }), card({ name: "Sol Ring" })];
    expect(foldForFields(rows, ["quantity", "name"]).map((c) => c.name)).toEqual([
      "Sol Ring",
      "Arcane Signet",
    ]);
  });

  it("sums the tradelist quantity alongside the quantity, never keying on it", () => {
    const rows = [
      card({ quantity: 2, tradelistQuantity: 1 }),
      card({ quantity: 1, tradelistQuantity: 3 }),
    ];
    const folded = foldForFields(rows, ["quantity", "name", "tradelistQuantity"]);
    expect(folded).toHaveLength(1);
    expect(folded[0].tradelistQuantity).toBe(4);
  });

  it("is a no-op on an empty list", () => {
    expect(foldForFields([], ["quantity", "name"])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/export/fold.test.ts`

Expected: FAIL — cannot resolve `./fold`.

- [ ] **Step 3: Write `fold.ts`**

```ts
/**
 * Rows the chosen fields cannot tell apart become one row, with the copies summed.
 *
 * **A correctness rule wearing a formatting hat.** The collection's grain keeps 2 NM and 1 LP
 * Lightning Bolt as two rows on purpose. A plain-text export has no condition channel, so
 * writing them as two lines produces a file that names one card twice — and a reader pasting
 * that into Moxfield gets a deck with a duplicate in it. Fold on what the file can actually
 * say, and the same two rows separate again the moment Condition is switched on.
 *
 * The two quantity fields are **summed, never keyed on**: they are what folding accumulates.
 */
import { TRANSFER_FIELDS, TRANSFER_FIELD_IDS, type TransferFieldId } from "../fields";
import type { TransferCard } from "../TransferCard";

const SUMMED: readonly TransferFieldId[] = ["quantity", "tradelistQuantity"];

export function foldForFields(
  cards: readonly TransferCard[],
  fields: readonly TransferFieldId[],
): TransferCard[] {
  const keyed = fields.filter((id) => !SUMMED.includes(id));
  // A Map preserves insertion order, which is what keeps the caller's order the file's order.
  const out = new Map<string, TransferCard>();
  for (const card of cards) {
    // JSON rather than a joined string: it escapes, so no separator a card name could
    // contain can make two different rows share one key.
    const key = JSON.stringify(keyed.map((id) => TRANSFER_FIELDS[id].read(card)));
    const seen = out.get(key);
    if (seen === undefined) {
      out.set(key, { ...card });
      continue;
    }
    seen.quantity += card.quantity;
    if (seen.tradelistQuantity !== null && card.tradelistQuantity !== null) {
      seen.tradelistQuantity += card.tradelistQuantity;
    }
  }
  return [...out.values()];
}
```

The key is JSON rather than a joined string because a card name may contain any printable character. With a plain separator, the rows `Sol Ring` + `` and `Sol` + `Ring` produce one key and fold into a single line — a file with the wrong number of cards in it.

- [ ] **Step 4: Run the test**

Run: `npm run test:run -- src/features/transfer/export/fold.test.ts`

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/transfer/export/fold.ts src/features/transfer/export/fold.test.ts
git commit -m "feat(transfer): fold rows a field set cannot tell apart"
```

---

### Task 7: `csv.ts` — RFC 4180 both ways

**Files:**
- Create: `src/features/transfer/csv.ts`
- Create: `src/features/transfer/csv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `csvField(value: string): string`, `csvRow(values: readonly string[]): string`, `parseCsv(text: string): string[][]`.

- [ ] **Step 1: Write the failing test**

Create `src/features/transfer/csv.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { csvField, csvRow, parseCsv } from "./csv";

describe("csvField", () => {
  it("leaves an ordinary value alone", () => {
    expect(csvField("Lightning Bolt")).toBe("Lightning Bolt");
  });

  it("quotes a value carrying a comma, a quote or a newline, and doubles an inner quote", () => {
    expect(csvField("Bolt, the")).toBe('"Bolt, the"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});

describe("csvRow", () => {
  it("joins fields with commas, quoting only what needs it", () => {
    expect(csvRow(["2", "Bolt, the", "LEA"])).toBe('2,"Bolt, the",LEA');
  });
});

describe("parseCsv", () => {
  it("reads a plain grid", () => {
    expect(parseCsv("Quantity,Name\n2,Lightning Bolt\n")).toEqual([
      ["Quantity", "Name"],
      ["2", "Lightning Bolt"],
    ]);
  });

  it("reads a quoted field carrying a comma", () => {
    expect(parseCsv('1,"Bolt, the"\n')).toEqual([["1", "Bolt, the"]]);
  });

  it("reads a doubled quote as one quote", () => {
    expect(parseCsv('1,"say ""hi"""\n')).toEqual([["1", 'say "hi"']]);
  });

  it("reads a newline inside a quoted field as part of the field", () => {
    expect(parseCsv('1,"two\nlines"\n')).toEqual([["1", "two\nlines"]]);
  });

  it("takes CRLF, and does not leave a stray carriage return in the last field", () => {
    expect(parseCsv("a,b\r\nc,d\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("drops a trailing blank line rather than reporting an empty row", () => {
    expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
    expect(parseCsv("a,b")).toEqual([["a", "b"]]);
  });

  it("keeps an empty field as an empty string", () => {
    expect(parseCsv("a,,c\n")).toEqual([["a", "", "c"]]);
  });

  it("is the inverse of csvRow for every shape csvField can produce", () => {
    const values = ["plain", "with, comma", 'with "quote"', "with\nnewline", ""];
    expect(parseCsv(csvRow(values) + "\n")).toEqual([values]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/csv.test.ts`

Expected: FAIL — cannot resolve `./csv`.

- [ ] **Step 3: Write `csv.ts`**

```ts
/**
 * CSV, RFC 4180, both directions.
 *
 * The writer is `export/format.ts`'s old private `csvField` promoted, unchanged in behaviour: a
 * field is quoted when it carries a comma, a quote or a newline and **never otherwise**, so
 * `Lightning Bolt` stays `Lightning Bolt` rather than becoming `"Lightning Bolt"` on every row.
 *
 * The reader is new, and it is what makes a collection CSV a restore rather than a dump. A
 * character-by-character scanner rather than a split on commas: a quoted field may contain
 * commas *and newlines*, so there is no line-oriented shortcut that is correct.
 */

/** A field, quoted only when it has to be. An inner quote doubles — RFC 4180's escape. */
export function csvField(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function csvRow(values: readonly string[]): string {
  return values.map(csvField).join(",");
}

/**
 * Text into a grid of rows and fields.
 *
 * A trailing newline produces no final empty row — every file this app writes ends in one, and
 * a phantom row of blanks would become a nameless import issue for every export ever opened.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;

  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        // A doubled quote is one quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      endRow();
      // CRLF is one break, not two.
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  // Whatever is still in hand is the last row — unless the file ended on a break, in which
  // case there is nothing in hand and no row to add.
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:run -- src/features/transfer/csv.test.ts`

Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/features/transfer/csv.ts src/features/transfer/csv.test.ts
git commit -m "feat(transfer): RFC 4180 CSV, readable as well as writable"
```

---

### Task 8: The writers compose from a field set

**Files:**
- Modify: `src/features/transfer/export/format.ts`
- Modify: `src/features/transfer/export/format.test.ts`
- Modify: `src/features/transfer/decklists.test.ts`
- Modify: `src/features/transfer/export/ExportDialog.tsx` (call site only — the dialog's own controls arrive in Task 9)
- Modify: `src/features/decks/DeckEditor.tsx` and `src/features/decks/categoryMenu.tsx` (they build `ExportCard[]`; they now build `TransferCard[]` via `fromDeckCard`)

**Interfaces:**
- Consumes: `TransferCard`, `fromDeckCard` (Task 4); `availableFields`, `defaultFields`, `TRANSFER_FIELDS`, `TransferFieldId`, `TransferSurface` (Task 5); `foldForFields` (Task 6); `csvRow` (Task 7).
- Produces: `formatExport(cards: readonly TransferCard[], format: ExportFormat, fields: readonly TransferFieldId[]): string`, `omittedCount(cards: readonly TransferCard[], format: ExportFormat): number`. The `ExportCard` type is **deleted**.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/transfer/export/format.test.ts`. First replace its `card()` helper so it builds a `TransferCard` (copy the helper from Task 6's `fold.test.ts` and add the three category defaults back: `categoryName: "Main deck", categoryKind: "main", categoryActive: true`). Then add:

```ts
import { defaultFields } from "../fields";

describe("field selection", () => {
  const DECK = "deck" as const;

  it("writes exactly what it wrote before, at every format's defaults", () => {
    // The whole point of `defaultOn`. If this goes red, a default moved and every deck
    // exported since shipped a different file.
    expect(formatExport([BOLT], "plain", defaultFields("plain", DECK))).toBe(
      "2 Lightning Bolt\n",
    );
    expect(formatExport([card()], "moxfield", defaultFields("moxfield", DECK))).toBe(
      "Deck\n1 Sol Ring (LTC) 285\n",
    );
    expect(formatExport([card()], "archidekt", defaultFields("archidekt", DECK))).toBe(
      "Main deck\n1x Sol Ring (ltc) 285 [Main deck]\n",
    );
    expect(formatExport([card()], "tcgplayer", defaultFields("tcgplayer", DECK))).toBe(
      "1 Sol Ring [LTC] 285\n",
    );
  });

  it("drops the printing from a Moxfield line when the reader switches it off", () => {
    expect(formatExport([card()], "moxfield", ["quantity", "name"])).toBe("Deck\n1 Sol Ring\n");
  });

  it("drops the bracket from an Archidekt line when the category is switched off", () => {
    expect(
      formatExport([card()], "archidekt", ["quantity", "name", "setCode", "collectorNumber"]),
    ).toBe("Main deck\n1x Sol Ring (ltc) 285\n");
  });

  it("writes the finish mark only when the finish is on", () => {
    const foil = card({ finish: "foil" });
    expect(formatExport([foil], "plain", ["quantity", "name", "finish"])).toBe(
      "1 Sol Ring *F*\n",
    );
    expect(formatExport([foil], "plain", ["quantity", "name"])).toBe("1 Sol Ring\n");
  });

  it("makes CSV's columns the chosen fields, header and all", () => {
    expect(formatExport([card()], "csv", ["quantity", "name", "condition"])).toBe(
      "Quantity,Name,Condition\n1,Sol Ring,\n",
    );
  });

  it("writes one flat list on a surface with no categories", () => {
    // A collection row has `categoryKind: null`, so there is no section to head.
    const row = card({ categoryName: null, categoryKind: null, categoryActive: null });
    expect(formatExport([row], "moxfield", ["quantity", "name"])).toBe("1 Sol Ring\n");
  });

  it("folds two rows a field set cannot tell apart before writing them", () => {
    const nm = card({ name: "Bolt", quantity: 2, condition: "NM", categoryKind: null,
      categoryName: null, categoryActive: null });
    const lp = card({ name: "Bolt", quantity: 1, condition: "LP", categoryKind: null,
      categoryName: null, categoryActive: null });
    expect(formatExport([nm, lp], "plain", ["quantity", "name"])).toBe("3 Bolt\n");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:run -- src/features/transfer/export/format.test.ts`

Expected: FAIL — `formatExport` takes two arguments.

- [ ] **Step 3: Rewrite the writers**

In `src/features/transfer/export/format.ts`, keep every existing doc comment that still holds and replace the machinery:

```ts
import { csvRow } from "../csv";
import { TRANSFER_FIELDS, TRANSFER_FIELD_IDS, type TransferFieldId } from "../fields";
import type { ExportFormat } from "../formats";
import type { TransferCard } from "../TransferCard";
import { foldForFields } from "./fold";

/** How one format shapes the segments a field set turns on. */
interface LineSpec {
  /** Archidekt's `1x`; everyone else's `1`. */
  quantitySuffix: string;
  setCase: "upper" | "lower";
  setWrap: "parens" | "brackets";
}

const LINE_SPEC: Record<ExportFormat, LineSpec> = {
  plain: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  mtgo: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  arena: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  moxfield: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
  // Lowercase against every other writer on purpose: it is what Archidekt itself emits, and
  // our own parser uppercases what it reads, so the round trip is unaffected either way.
  archidekt: { quantitySuffix: "x", setCase: "lower", setWrap: "parens" },
  tcgplayer: { quantitySuffix: "", setCase: "upper", setWrap: "brackets" },
  csv: { quantitySuffix: "", setCase: "upper", setWrap: "parens" },
};

/**
 * One line, assembled from the segments the field set turns on.
 *
 * **No per-format gating here, and that is the point.** The set handed in has already been
 * intersected with what this format can carry, so a `setCode` reaching this function is a
 * `setCode` the format has somewhere to put. Six line formats fall out of one composer and a
 * three-field spec.
 */
function writeLine(
  card: TransferCard,
  fields: ReadonlySet<TransferFieldId>,
  spec: LineSpec,
): string {
  const parts = [`${card.quantity}${spec.quantitySuffix}`, card.name];
  if (fields.has("setCode") && card.setCode !== null && card.setCode !== "") {
    const set = spec.setCase === "lower" ? card.setCode.toLowerCase() : card.setCode.toUpperCase();
    parts.push(spec.setWrap === "brackets" ? `[${set}]` : `(${set})`);
  }
  if (fields.has("collectorNumber") && card.collectorNumber !== null) {
    parts.push(card.collectorNumber);
  }
  let line = parts.join(" ");
  if (fields.has("category") && card.categoryName !== null) {
    // `{noDeck}` is what makes an export and a re-import keep a maybeboard — the only format
    // here that can say it.
    line += ` [${card.categoryName}${card.categoryActive === false ? "{noDeck}" : ""}]`;
  }
  if (fields.has("finish")) line += finishMark(card);
  return line;
}
```

`sectionOf` becomes nullable, which is what makes a category-less surface write flat:

```ts
/** The section a card writes under, or `null` on a surface that has no piles at all. */
function sectionOf(card: TransferCard): string | null {
  if (card.categoryKind === null) return null;
  return card.categoryActive === false ? MAYBEBOARD : KIND_SECTION[card.categoryKind];
}
```

`grouped` and `sections` gain the flat arm: if `keyOf` answers `null` for every card, write the lines with no heading and no blank line between them.

```ts
function sectioned(
  cards: readonly TransferCard[],
  keyOf: (card: TransferCard) => string | null,
  write: (card: TransferCard) => string,
  order?: readonly string[],
): string {
  if (cards.every((card) => keyOf(card) === null)) return cards.map(write).join("\n");
  const groups = new Map<string, TransferCard[]>();
  for (const card of cards) {
    const key = keyOf(card) ?? "";
    const existing = groups.get(key);
    if (existing) existing.push(card);
    else groups.set(key, [card]);
  }
  const entries = [...groups];
  if (order !== undefined) entries.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  return entries.map(([name, rows]) => [name, ...rows.map(write)].join("\n")).join("\n\n");
}
```

`omittedCount` keeps its body but takes a `TransferCard[]`, and answers 0 when `categoryActive` is `null` — a surface with no piles has none switched off:

```ts
export function omittedCount(cards: readonly TransferCard[], format: ExportFormat): number {
  if (!ACTIVE_ONLY.has(format)) return 0;
  return cards.reduce((n, card) => (card.categoryActive === false ? n + card.quantity : n), 0);
}
```

And `formatExport`:

```ts
export function formatExport(
  cards: readonly TransferCard[],
  format: ExportFormat,
  fields: readonly TransferFieldId[],
): string {
  const set = new Set(fields);
  // **Filter first, fold second, and the order is load-bearing.** Folding first can merge a
  // switched-off row into a switched-on one — the folded row inherits the FIRST card's
  // `categoryActive` — so an Arena export would carry copies that `omittedCount` reports as
  // omitted in the same breath. Filtering first means nothing inactive survives to be folded,
  // and the sentence beside the format stays true of the file under it.
  const rows = foldForFields(written(cards, format), fields);
  if (rows.length === 0) return "";
  const spec = LINE_SPEC[format];
  const line = (card: TransferCard) => writeLine(card, set, spec);

  let text: string;
  switch (format) {
    case "plain":
      text = rows.map(line).join("\n");
      break;
    case "mtgo":
      text = rows
        .map((card) => {
          const section = sectionOf(card);
          const prefix = section === "Sideboard" || section === "Companion" ? "SB: " : "";
          return prefix + line(card);
        })
        .join("\n");
      break;
    case "arena":
    case "moxfield":
      text = sectioned(rows, sectionOf, line, SECTION_ORDER);
      break;
    case "archidekt":
      // Grouped by the pile's own name rather than a section word, and in the caller's order:
      // a deck's array order is its category order, and imposing one here would re-file
      // somebody's deck on the way out.
      text = sectioned(rows, (card) => card.categoryName, line);
      break;
    case "tcgplayer":
      text = rows.map(line).join("\n");
      break;
    case "csv": {
      const columns = TRANSFER_FIELD_IDS.filter((id) => set.has(id));
      text = [
        csvRow(columns.map((id) => TRANSFER_FIELDS[id].csvHeader)),
        ...rows.map((card) => csvRow(columns.map((id) => TRANSFER_FIELDS[id].read(card)))),
      ].join("\n");
      break;
    }
  }
  return text + "\n";
}
```

Delete `ExportCard`, `plainLine`, `printedLine`, `moxfieldLine`, `archidektLine`, `tcgplayerLine`, `csvField`, `CSV_HEADER`, `grouped` and `sections`.

- [ ] **Step 4: Fix the two call sites**

`src/features/decks/DeckEditor.tsx`'s `exportSubject` and `src/features/decks/categoryMenu.tsx` build the card array. Map through `fromDeckCard`:

```ts
import { fromDeckCard } from "@/features/transfer/TransferCard";
// …
cards: rows.map(fromDeckCard),
```

`ExportDialog.tsx` changes only its prop type (`cards: readonly TransferCard[]`) and, for now, passes `defaultFields(format, "deck")` into `formatExport` so it still compiles. Task 9 replaces that with real state.

- [ ] **Step 5: Fix `decklists.test.ts`**

Its `ExportCard` import becomes `TransferCard` and its helper gains the null fields. Every `formatExport(cards, format)` gains a third argument: `defaultFields(format, "deck")`.

- [ ] **Step 6: Run everything**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: green. The round trip in `decklists.test.ts` still excludes `csv` and `tcgplayer` by name — CSV leaves that list in Task 10, not here.

- [ ] **Step 7: Commit**

```bash
rm verify.log
git add -A
git commit -m "feat(transfer): compose every writer from a chosen field set"
```

---

### Task 9: The export dialog offers the fields, and remembers them

**Files:**
- Modify: `src/features/transfer/export/ExportDialog.tsx`
- Modify: `src/features/transfer/export/ExportDialog.test.tsx`
- Modify: `src/lib/store.ts`
- Modify: `src/lib/store.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 4–8.
- Produces: `ExportDialogProps { open, subject, surface: TransferSurface, cards: readonly TransferCard[], suggestedFileName, onDismiss, onClose }`. Store: `exportPrefs: Record<TransferSurface, { format: ExportFormat; fields: TransferFieldId[] }>` and `setExportPrefs(surface, prefs)`.

- [ ] **Step 1: Write the failing store test**

Add to `src/lib/store.test.ts`:

```ts
it("remembers an export choice per surface, so a deck export is not dragged into the collection's", () => {
  useAppStore.getState().setExportPrefs("collection", {
    format: "csv",
    fields: ["quantity", "name", "condition"],
  });
  expect(useAppStore.getState().exportPrefs.collection.format).toBe("csv");
  expect(useAppStore.getState().exportPrefs.deck.format).toBe("plain");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/lib/store.test.ts`

Expected: FAIL — `setExportPrefs is not a function`.

- [ ] **Step 3: Add the slice to `store.ts`**

In the `AppState` interface:

```ts
  /**
   * The format and field set each surface was last exported with.
   *
   * **Per surface rather than globally**: a deck export wants Moxfield's printing line and a
   * collection export wants a CSV with a condition column, and one remembered setting would
   * make each of them wrong half the time.
   */
  exportPrefs: Record<TransferSurface, { format: ExportFormat; fields: TransferFieldId[] }>;
  setExportPrefs: (
    surface: TransferSurface,
    prefs: { format: ExportFormat; fields: TransferFieldId[] },
  ) => void;
```

In the store body:

```ts
  exportPrefs: {
    deck: { format: "plain", fields: defaultFields("plain", "deck") },
    collection: { format: "csv", fields: defaultFields("csv", "collection") },
    wishlist: { format: "plain", fields: defaultFields("plain", "wishlist") },
  },
  setExportPrefs: (surface, prefs) =>
    set((s) => ({ exportPrefs: { ...s.exportPrefs, [surface]: prefs } })),
```

A collection opens on CSV because that is the only format that can carry a condition, and a collection without conditions is a card list rather than a record of what the reader owns.

- [ ] **Step 4: Run the store test**

Run: `npm run test:run -- src/lib/store.test.ts`

Expected: PASS.

- [ ] **Step 5: Write the failing dialog tests**

Add to `src/features/transfer/export/ExportDialog.test.tsx`, using the render helper and `props` object that file already defines:

```ts
it("offers only the fields this format and this surface share", async () => {
  render(<ExportDialog {...props} surface="wishlist" />);
  await user.click(screen.getByRole("radio", { name: "Archidekt" }));
  // A wishlist has no piles, so the format's bracket has nothing to put in it.
  expect(screen.queryByRole("checkbox", { name: "Category" })).not.toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Collector number" })).toBeInTheDocument();
});

it("redraws the preview when a field is switched off", async () => {
  render(<ExportDialog {...props} surface="deck" />);
  await user.click(screen.getByRole("radio", { name: "Moxfield" }));
  await user.click(screen.getByRole("button", { name: /Show decklist/ }));
  expect(screen.getByText(/Sol Ring \(LTC\) 285/)).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Set code" }));
  expect(screen.queryByText(/\(LTC\)/)).not.toBeInTheDocument();
});

it("clears the Copied claim when a field moves, not only when the format does", async () => {
  // The clipboard still holds the old text; the sentence beside it would stop being true.
  render(<ExportDialog {...props} surface="deck" />);
  await user.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByText("Copied.")).toBeInTheDocument();
  await user.click(screen.getByRole("checkbox", { name: "Finish" }));
  expect(screen.queryByText("Copied.")).not.toBeInTheDocument();
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `npm run test:run -- src/features/transfer/export/ExportDialog.test.tsx`

Expected: FAIL — no checkbox role in the tree.

- [ ] **Step 7: Add the checkbox row and the persistence**

In `Body`, replace the local `format` state with the store slice, and add a `fields` state beside it:

```ts
const prefs = useAppStore((s) => s.exportPrefs[surface]);
const setPrefs = useAppStore((s) => s.setExportPrefs);
const { format, fields } = prefs;
const available = useMemo(() => availableFields(format, surface), [format, surface]);

/** Switching format re-derives the field set from that format's defaults rather than
 *  carrying the old set across: a set chosen for CSV means nothing to Arena, and the
 *  intersection would silently drop most of it anyway. */
const chooseFormat = (next: ExportFormat) => {
  setPrefs(surface, { format: next, fields: defaultFields(next, surface) });
  setCopied(false);
};

const toggleField = (id: TransferFieldId) => {
  const on = fields.includes(id);
  setPrefs(surface, {
    format,
    fields: on ? fields.filter((f) => f !== id) : [...fields, id],
  });
  // The preview redraws; the clipboard does not.
  setCopied(false);
};
```

Then the row itself, under the format radios:

```tsx
{/* Only the fields this format and this surface share — `availableFields` is the whole of
    the rule, so nothing here is a list to remember to grow. `ALWAYS` is not drawn: a line
    with no count and no name is not a card, and a disabled checkbox that can never move is
    furniture rather than a control. */}
{available.filter((id) => !ALWAYS.includes(id)).length > 0 && (
  <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
    <legend className="mb-1 text-sm text-dim">Fields</legend>
    {available
      .filter((id) => !ALWAYS.includes(id))
      .map((id) => (
        <label key={id} className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={fields.includes(id)}
            onChange={() => toggleField(id)}
            className={cn("size-4 accent-accent", FOCUS)}
          />
          {TRANSFER_FIELDS[id].label}
        </label>
      ))}
  </fieldset>
)}
```

`text` and `omitted` gain `fields` in their dependency arrays:

```ts
const text = useMemo(() => formatExport(cards, format, fields), [cards, format, fields]);
```

- [ ] **Step 8: Run the dialog tests**

Run: `npm run test:run -- src/features/transfer/export/ExportDialog.test.tsx`

Expected: PASS. If a story test fails on the fieldset, `ExportDialog.stories.tsx` needs its args widened with `surface="deck"` — do that now.

- [ ] **Step 9: Verify and commit**

```bash
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
rm verify.log
git add -A
git commit -m "feat(transfer): the export dialog offers its fields and remembers them per surface"
```

---

### Task 10: The parser reads a CSV

**Files:**
- Modify: `src/features/transfer/import/parse.ts`
- Modify: `src/features/transfer/import/parse.test.ts`
- Modify: `src/features/transfer/decklists.test.ts` (CSV leaves the round-trip exclusion list)

**Interfaces:**
- Consumes: `parseCsv` (Task 7), `TRANSFER_FIELDS`, `TRANSFER_FIELD_IDS`, `TransferFieldId` (Task 5).
- Produces: `ParsedLine` gains `extra: Partial<Record<TransferFieldId, string>>` — every recognised column, verbatim. The deck planner ignores it; the collection planner reads it. `parseDecklist` is unchanged in signature.

- [ ] **Step 1: Write the failing tests**

Add to `src/features/transfer/import/parse.test.ts`:

```ts
describe("a CSV", () => {
  it("is recognised by its header row and read by column", () => {
    const list = parseDecklist("Quantity,Name,Set,Collector number\n2,Lightning Bolt,LEA,161\n");
    expect(list.lines).toHaveLength(1);
    expect(list.lines[0]).toMatchObject({
      quantity: 2,
      name: "Lightning Bolt",
      setCode: "LEA",
      collectorNumber: "161",
    });
  });

  it("carries the columns no decklist format has, for a destination that wants them", () => {
    const list = parseDecklist("Quantity,Name,Condition,Purchase price\n1,Sol Ring,LP,2.5\n");
    expect(list.lines[0].extra).toMatchObject({ condition: "LP", purchasePrice: "2.5" });
  });

  it("matches a header regardless of case and surrounding space", () => {
    const list = parseDecklist(" quantity , NAME \n3,Forest\n");
    expect(list.lines[0]).toMatchObject({ quantity: 3, name: "Forest" });
  });

  it("ignores a column it does not know, rather than refusing the file", () => {
    const list = parseDecklist("Quantity,Name,Scryfall ID\n1,Sol Ring,abc-123\n");
    expect(list.lines).toHaveLength(1);
    expect(list.issues).toHaveLength(0);
  });

  it("refuses a file with no name column, in one sentence rather than 400", () => {
    const list = parseDecklist("Quantity,Set\n1,LEA\n2,LTC\n");
    expect(list.lines).toHaveLength(0);
    expect(list.issues).toHaveLength(1);
    expect(list.issues[0].reason).toMatch(/name/i);
  });

  it("reads the finish column as the marker every other format spells *F*", () => {
    const list = parseDecklist("Quantity,Name,Finish\n1,Sol Ring,foil\n");
    expect(list.lines[0].finish).toBe("foil");
  });

  it("leaves a list whose first line is not a header exactly as it was", () => {
    // The one file-level judgement this parser makes, and it is made on the header alone.
    const list = parseDecklist("2 Lightning Bolt\n1 Sol Ring\n");
    expect(list.lines.map((l) => l.name)).toEqual(["Lightning Bolt", "Sol Ring"]);
  });

  it("does not mistake a one-column list for a header", () => {
    // `Name` alone maps to one known header; two are required, one of which is the name.
    const list = parseDecklist("Name\nSol Ring\n");
    expect(list.lines.map((l) => l.name)).toEqual(["Name", "Sol Ring"]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:run -- src/features/transfer/import/parse.test.ts`

Expected: FAIL — the header row is read as a card called `Quantity,Name,Set,Collector number`.

- [ ] **Step 3: Add the CSV arm**

At the top of `parse.ts`, add the header map and the detector:

```ts
/**
 * A CSV header maps to field ids by `csvHeader`, case- and space-insensitively.
 *
 * Built from the registry rather than written out, so a field added there is readable back
 * without a second edit here — which is the whole reason the registry carries a `csvHeader` at
 * all rather than the writer spelling one inline.
 */
const HEADER_TO_FIELD = new Map<string, TransferFieldId>(
  TRANSFER_FIELD_IDS.map((id) => [normalizeHeader(TRANSFER_FIELDS[id].csvHeader), id]),
);

function normalizeHeader(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Is the first row a header?
 *
 * **Two known columns, one of which is the name.** One is not enough: a plain list whose first
 * card happens to be called `Name` would otherwise be read as a header over a nameless file.
 * This is the only file-level judgement in this parser, and every line after it is still read
 * by the per-line rules — a file whose first row is not a header is read exactly as before.
 */
function csvHeaderOf(row: readonly string[]): TransferFieldId[] | null {
  if (row.length < 2) return null;
  const mapped = row.map((cell) => HEADER_TO_FIELD.get(normalizeHeader(cell)) ?? null);
  const known = mapped.filter((id) => id !== null);
  if (known.length < 2) return null;
  if (!known.includes("name")) return null;
  return mapped as TransferFieldId[];
}
```

Then, at the top of `parseDecklist`, before the per-line loop:

```ts
  const grid = parseCsv(text);
  const header = grid.length > 0 ? csvHeaderOf(grid[0]) : null;
  if (header !== null) return parseCsvGrid(grid, header);
```

And the reader itself:

```ts
/**
 * A CSV grid into the same lines every other format produces.
 *
 * `extra` carries every recognised column verbatim — including the ones no decklist format has
 * a channel for. The deck planner never looks at it; the collection's reads condition, purchase
 * price and the rest out of it. Keeping them on the line rather than in a second return value is
 * what lets one `ParsedList` serve four destinations.
 */
function parseCsvGrid(grid: string[][], header: readonly (TransferFieldId | null)[]): ParsedList {
  const lines: ParsedLine[] = [];
  const issues: ParseIssue[] = [];

  for (let r = 1; r < grid.length; r += 1) {
    const row = grid[r];
    const lineNumber = r + 1;
    const raw = row.join(",");
    const cell = (id: TransferFieldId): string => {
      const at = header.indexOf(id);
      return at === -1 ? "" : (row[at] ?? "").trim();
    };

    const name = cell("name");
    if (name === "") {
      // A wholly blank row is a spreadsheet's trailing line, not a claim about a card.
      if (row.every((v) => v.trim() === "")) continue;
      issues.push({ lineNumber, raw, reason: "this row names no card" });
      continue;
    }
    const quantityCell = cell("quantity");
    const quantity = quantityCell === "" ? 1 : Number.parseInt(quantityCell, 10);
    if (!Number.isFinite(quantity) || quantity < 1) {
      issues.push({ lineNumber, raw, reason: `\`${quantityCell}\` is not a count of copies` });
      continue;
    }

    const extra: Partial<Record<TransferFieldId, string>> = {};
    for (const id of header) {
      if (id === null) continue;
      const value = cell(id);
      if (value !== "") extra[id] = value;
    }

    const setCode = cell("setCode");
    const finish = cell("finish").toLowerCase();
    const categoryCell = cell("category") === "" ? null : cell("category");
    // **A Category cell goes through the same section vocabulary a bracket does** — parse.ts
    // already does exactly this for a bracket's first entry. `Sideboard` names one of the four
    // seeded zones, so it must set the SECTION rather than becoming a category called
    // "Sideboard" that `category_for_name` would then find-or-create by name anyway.
    const knownSection =
      categoryCell === null ? null : (SECTIONS.get(categoryCell.toLowerCase()) ?? null);
    lines.push({
      lineNumber,
      raw,
      quantity,
      name,
      setCode: setCode === "" ? null : setCode.toUpperCase(),
      collectorNumber: cell("collectorNumber") === "" ? null : cell("collectorNumber"),
      section: knownSection ?? "deck",
      // Null whenever the section is not `deck` — `ParsedLine`'s stated invariant, and what
      // keeps plan.ts's precedence chain three rungs rather than four. Only a word the section
      // vocabulary has never heard of lands here.
      categoryName: knownSection === null ? categoryCell : null,
      finish: finish === "foil" ? "foil" : finish === "etched" ? "etched" : null,
      excluded: false,
      extra,
    });
  }
  // `ParsedList` carries four fields, not two. `totalCards` is copies rather than rows, and
  // `suggestedName` is Arena's `About` block — a CSV has no such thing and answers null.
  return {
    lines,
    issues,
    totalCards: lines.reduce((n, l) => n + l.quantity, 0),
    suggestedName: null,
  };
}
```

A grid whose header has no name column never reaches here — `csvHeaderOf` answers `null` and the file falls through to the per-line reader, which would name 400 issues. So add the explicit refusal in `parseDecklist`, before the fall-through:

```ts
  // A header this app *nearly* recognises — two or more known columns but no name — is a CSV
  // somebody exported from somewhere else, and reading it line by line would produce one issue
  // per row saying nothing useful. One sentence is the honest answer.
  if (header === null && grid.length > 0 && nearlyAHeader(grid[0])) {
    return {
      lines: [],
      issues: [
        {
          lineNumber: 1,
          raw: grid[0].join(","),
          reason: "this looks like a spreadsheet, but no column names the card",
        },
      ],
      totalCards: 0,
      suggestedName: null,
    };
  }
```

with:

```ts
/** Two or more known column names, whatever they are — the test `csvHeaderOf` makes before it
 *  insists on a name. */
function nearlyAHeader(row: readonly string[]): boolean {
  if (row.length < 2) return false;
  return row.filter((cell) => HEADER_TO_FIELD.has(normalizeHeader(cell))).length >= 2;
}
```

Finally add `extra` to the `ParsedLine` interface, optional-valued and always present:

```ts
  /** Every column a CSV named that this app recognises, verbatim. `{}` for every other format —
   *  a decklist line has no channel for a condition or a purchase price. */
  extra: Partial<Record<TransferFieldId, string>>;
```

and give the per-line reader `extra: {}` on every line it builds.

- [ ] **Step 4: Run the parser tests**

Run: `npm run test:run -- src/features/transfer/import/parse.test.ts`

Expected: PASS, including the eight new ones.

- [ ] **Step 5: Let CSV into the round trip**

In `src/features/transfer/decklists.test.ts`, remove `"csv"` from the exclusion list, leaving `"tcgplayer"` (whose bracket-then-number shape our own parser reads as part of the name — that is documented at `tcgplayerLine` and is not a bug this task fixes).

- [ ] **Step 6: Verify**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: green, with the CSV round trip now passing across all three reference decklists.

- [ ] **Step 7: Commit**

```bash
rm verify.log
git add -A
git commit -m "feat(transfer): read a CSV by its header row"
```

---

### Task 11: The paged sweep, and export from the collection and the wishlist

**Files:**
- Create: `src/features/transfer/export/scope.ts`
- Create: `src/features/transfer/export/scope.test.ts`
- Modify: `src/features/transfer/export/ExportDialog.tsx` (the scope line and the Everything toggle)
- Modify: `src/features/collection/CollectionPage.tsx`, `src/features/wishlist/WishlistPage.tsx`
- Modify: `src/features/collection/CollectionPage.test.tsx`, `src/features/wishlist/WishlistPage.test.tsx`

**Interfaces:**
- Consumes: `ipc.collectionList`, `ipc.wishlistList`; `fromCollectionRow`, `fromWishRow` (Task 4).
- Produces:
  - `sweep<TRow>(page: (limit: number, offset: number) => Promise<{ items: TRow[]; total: number }>, onProgress?: (loaded: number, total: number) => void): Promise<TRow[]>`
  - `SWEEP_PAGE = 500`
  - `useExportScope(surface, filters)` — a hook returning `{ cards, total, loading, everything, setEverything }`.

- [ ] **Step 1: Write the failing test**

Create `src/features/transfer/export/scope.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { SWEEP_PAGE, sweep } from "./scope";

describe("sweep", () => {
  it("keeps asking until it has the whole set", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({ id: i }));
    const page = vi.fn(async (limit: number, offset: number) => ({
      items: rows.slice(offset, offset + limit),
      total: rows.length,
    }));

    const all = await sweep(page);

    expect(all).toHaveLength(1200);
    expect(page).toHaveBeenCalledTimes(3);
    expect(page).toHaveBeenNthCalledWith(1, SWEEP_PAGE, 0);
    expect(page).toHaveBeenNthCalledWith(3, SWEEP_PAGE, 1000);
  });

  it("stops on a short page rather than trusting the total, which can move mid-sweep", async () => {
    const page = vi.fn(async (limit: number, offset: number) =>
      offset === 0 ? { items: [{ id: 1 }], total: 9999 } : { items: [], total: 9999 },
    );
    expect(await sweep(page)).toHaveLength(1);
    expect(page).toHaveBeenCalledTimes(1);
  });

  it("reports progress against the total it was told", async () => {
    const rows = Array.from({ length: 600 }, (_, i) => ({ id: i }));
    const seen: number[] = [];
    await sweep(
      async (limit, offset) => ({ items: rows.slice(offset, offset + limit), total: 600 }),
      (loaded) => seen.push(loaded),
    );
    expect(seen).toEqual([500, 600]);
  });

  it("answers an empty list without asking twice", async () => {
    const page = vi.fn(async () => ({ items: [], total: 0 }));
    expect(await sweep(page)).toEqual([]);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/export/scope.test.ts`

Expected: FAIL — cannot resolve `./scope`.

- [ ] **Step 3: Write the sweep**

```ts
/**
 * A filter becomes a whole list.
 *
 * The collection and the wishlist are `useInfiniteQuery` at 100 rows a page, so what is in
 * memory is a **scroll position** rather than a decision. Exporting that would silently truncate
 * a 3,000-card collection to the two hundred rows the reader happened to have scrolled past, and
 * the file would look complete.
 *
 * 500 a page rather than the list's own 100: six round trips for a 3,000-card collection instead
 * of thirty, and nothing here is drawing rows so the page size costs only memory.
 *
 * **The stop condition is a short page, not the total.** A write landing mid-sweep moves the
 * total, and believing it would either drop the tail or loop forever — the same reasoning
 * `useCollection`'s own `getNextPageParam` documents.
 */
export const SWEEP_PAGE = 500;

export async function sweep<TRow>(
  page: (limit: number, offset: number) => Promise<{ items: TRow[]; total: number }>,
  onProgress?: (loaded: number, total: number) => void,
): Promise<TRow[]> {
  const all: TRow[] = [];
  for (;;) {
    const { items, total } = await page(SWEEP_PAGE, all.length);
    all.push(...items);
    onProgress?.(all.length, total);
    if (items.length < SWEEP_PAGE) return all;
  }
}
```

- [ ] **Step 4: Run the test**

Run: `npm run test:run -- src/features/transfer/export/scope.test.ts`

Expected: PASS, 4 tests.

- [ ] **Step 5: Add the scope line to the dialog**

`ExportDialogProps` gains an optional scope:

```ts
  /**
   * What the dialog is about to write, when that is a *filtered* set rather than a thing the
   * reader pointed at. Absent on a deck export: a deck is what was clicked.
   */
  scope?: {
    /** "1,204 cards matching your filters" — already pluralised by the caller. */
    label: string;
    /** Still sweeping. The buttons are disabled while this is true. */
    loading: boolean;
    everything: boolean;
    onEverything: (everything: boolean) => void;
  };
```

Drawn above the format radios:

```tsx
{scope !== undefined && (
  <div className="flex flex-wrap items-center gap-3 text-sm">
    <span className="text-dim">{scope.label}</span>
    <label className="flex items-center gap-2">
      <input
        type="checkbox"
        checked={scope.everything}
        onChange={(e) => scope.onEverything(e.target.checked)}
        className={cn("size-4 accent-accent", FOCUS)}
      />
      Export everything, ignoring the filters
    </label>
  </div>
)}
```

and both action buttons take `aria-disabled={scope?.loading ? true : undefined}` with the same guard `Save as…` already uses for `saving`.

- [ ] **Step 6: Wire the two pages**

In `CollectionPage.tsx`, beside `<CollectionFilterBar collection={collection} />`, add a control row:

```tsx
<div className="flex items-center gap-2">
  <button type="button" onClick={() => setExporting(true)}
    className={cn("h-8 rounded-md border border-border px-3 text-sm hover:bg-surface", FOCUS)}>
    Export
  </button>
</div>
```

**Only the Export button in this task.** The Import button arrives in Task 14 with the destination it opens — a control that does nothing is worse than a missing one, and a disabled one invites a bug report.

The export dialog is mounted with a hook that sweeps on open:

```ts
const [exporting, setExporting] = useState(false);
const [everything, setEverything] = useState(false);
const rows = useQuery({
  queryKey: ["collection", "export", everything ? "all" : filters],
  enabled: exporting,
  queryFn: () =>
    sweep((limit, offset) =>
      ipc.collectionList({ ...(everything ? {} : filters), limit, offset }),
    ),
});
```

Do the same in `WishlistPage.tsx` with `ipc.wishlistList` and `fromWishRow`.

- [ ] **Step 7: Write the page tests**

Add to `src/features/collection/CollectionPage.test.tsx`:

```ts
it("exports every row the filter matches, not the page that happens to be loaded", async () => {
  // 250 rows, a 100-row list page, a 500-row sweep page: one sweep call for the lot.
  const list = vi.mocked(ipc.collectionList);
  render(<CollectionPage />);
  await user.click(await screen.findByRole("button", { name: "Export" }));
  await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ limit: 500 })));
  await user.click(await screen.findByRole("button", { name: /Show decklist/ }));
  // **251, not 250.** A collection opens on CSV (see the store's defaults) and CSV writes a
  // header row. Asserting the row count here is how a correct implementation reads as red.
  expect(screen.getByText(/251 lines/)).toBeInTheDocument();
});
```

- [ ] **Step 8: Verify and commit**

```bash
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
rm verify.log
git add -A
git commit -m "feat(transfer): export the whole filtered collection and wishlist"
```

---

### Task 12: The `ImportDestination` interface, with deck and new-deck ported onto it

No behaviour change. This is the seam that lets Task 14 add two destinations without touching the shell.

**Files:**
- Create: `src/features/transfer/import/destination.ts`
- Move: `src/features/transfer/import/plan.ts` → `src/features/transfer/import/destinations/deck.ts`
- Move: `src/features/transfer/import/plan.test.ts` → `src/features/transfer/import/destinations/deck.test.ts`
- Create: `src/features/transfer/import/destinations/newDeck.ts`
- Modify: `src/features/transfer/import/ImportDeckDialog.tsx` → renamed `ImportDialog.tsx`, taking a destination
- Modify: `src/features/transfer/import/useDeckImport.ts` → renamed `useImport.ts`

**Interfaces:**
- Consumes: `ParsedList` (four fields: `lines`, `issues`, `totalCards`, `suggestedName`), `ImportResolveRow` and `PrintingTags` from `@/lib/ipc`.
- Produces:

```ts
/**
 * A destination is **UI**, not domain logic.
 *
 * The planners stay plain exported functions — `buildImportPlan` for a deck,
 * `planCollectionImport`, `planWishlistImport` — fully typed and unit-tested on their own.
 * What a destination owns is the second step of the dialog: its options state, its preview, its
 * mode radios and its Import button.
 *
 * **Deliberately not generic**, and that is not laziness. A `ImportDestination<TItem, TOptions>`
 * cannot be held in one array by a shell that does not know which it has — parameter positions
 * are contravariant, so nothing widens to `ImportDestination<unknown, unknown>` — and every
 * escape from that (a union to narrow, a cast, a `usePrepared` hook whose identity changes when
 * the reader switches destination and breaks the rules of hooks) is worse than letting each
 * destination render its own step. Four short bodies over `Tally`, `ProblemList`, `ModeRadios`
 * and `CommitBar` cost less than one leaked type parameter.
 */
export interface ImportDestination {
  key: "deck" | "newDeck" | "collection" | "wishlist";
  /** The destination radio's word, and the dialog's title: `Import into <label>`. */
  label: string;
  Preview: (props: DestinationPreviewProps) => JSX.Element;
}

export interface DestinationPreviewProps {
  list: ParsedList;
  resolved: readonly ImportResolveRow[];
  /** One read for the whole list, made by the shell. Empty is a complete answer — the
   *  taxonomy has a supported state of never having been downloaded. */
  tags: readonly PrintingTags[];
  /** Close, reporting what landed. */
  onDone: (message: string) => void;
  /** Back to the paste step, keeping the text. */
  onBack: () => void;
}

/** One mode's word and the sentence under it. */
export interface ImportModeOption {
  key: string;
  label: string;
  hint: string;
}
```

- [ ] **Step 1: Write the failing contract test**

Create `src/features/transfer/import/destination.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { collectionDestination } from "./destinations/collection";
import { deckDestination } from "./destinations/deck";
import { newDeckDestination } from "./destinations/newDeck";
import { wishlistDestination } from "./destinations/wishlist";

// `collection` and `wishlist` arrive in Task 14; until then this array holds the two that
// exist and the test is still the contract.
const ALL = [deckDestination, newDeckDestination, collectionDestination, wishlistDestination];

describe("every destination", () => {
  it("has a unique key and a label the radio group can show", () => {
    expect(new Set(ALL.map((d) => d.key)).size).toBe(ALL.length);
    for (const d of ALL) expect(d.label).not.toBe("");
  });

  it("is a component, so the shell needs no knowledge of which one it holds", () => {
    for (const d of ALL) expect(typeof d.Preview).toBe("function");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm run test:run -- src/features/transfer/import/destination.test.ts`

Expected: FAIL — cannot resolve `./destinations/deck`. Trim the import list and `ALL` to the two destinations this task creates; Task 14 puts the other two back.

- [ ] **Step 3: Move `plan.ts` and add the descriptor**

```bash
mkdir -p src/features/transfer/import/destinations
git mv src/features/transfer/import/plan.ts src/features/transfer/import/destinations/deck.ts
git mv src/features/transfer/import/plan.test.ts src/features/transfer/import/destinations/deck.test.ts
```

Fix the relative imports (`./parse` → `../parse`, `./fixtures` → `../fixtures`) **and
`decklists.test.ts`'s `./import/plan`, which becomes `./import/destinations/deck`** — it is the
one importer outside this folder and the round-trip suite will not resolve without it.
`buildImportPlan`, `tallyOf`, `toImportItems`, `SECTION_CATEGORY` and the `ImportPlan` interface are **unchanged** — `ImportPlan` keeps its own field names (`cards: PlannedCard[]`, `unmatched`, `hintMisses`, `parseIssues`, `commander`, `totalCards`), and `toImportItems(plan, commanderIds)` is still what turns a plan into `ImportItem[]`.

Create `src/features/transfer/import/destinations/DeckPreview.tsx` by lifting the preview half of today's `ImportDeckDialog.tsx` out whole — `Headline`, `Tally`, `Commander`, `CandidateButton`, `Problems`, `ProblemList`, `Mode` — and give it the state that used to live in `ImportBody`: the chosen variant, the chosen commander, the mode, and the `commit` mutation. Its props are `DestinationPreviewProps` plus the two facts only the deck editor knows:

```tsx
export function DeckPreview({ list, resolved, tags, onDone, onBack,
  deckId, deckName }: DestinationPreviewProps & { deckId: number; deckName: string }) {
  const plan = useMemo(() => buildImportPlan(list, resolved, tags), [list, resolved, tags]);
  // …the existing preview markup, unchanged…
}
```

Then the descriptor at the bottom of `deck.ts`:

```ts
export const DECK_MODES: readonly ImportModeOption[] = [
  { key: "merge", label: "Add to what is here", hint: "Quantities add up." },
  { key: "replace", label: "Replace this list", hint: "Every card here is cleared first." },
];

/**
 * The deck as a destination. Every planning function above is unchanged — this is the seam
 * that lets three more destinations exist without the dialog knowing there are four.
 */
export const deckDestination: ImportDestination = {
  key: "deck",
  label: "this deck",
  Preview: DeckPreview as ImportDestination["Preview"],
};
```

The cast is the one place the extra props are erased, and it is safe because `DeckEditor` is the only mounter and supplies them through a wrapper:

```tsx
const deckInto = useMemo<ImportDestination>(
  () => ({
    ...deckDestination,
    Preview: (props) => <DeckPreview {...props} deckId={deck.id} deckName={deck.name} />,
  }),
  [deck.id, deck.name],
);
```

Prefer the wrapper at the call site and drop the cast from `deck.ts` entirely — `deckDestination.Preview` then takes only `DestinationPreviewProps` and the deck's identity is closed over where it is known.

- [ ] **Step 4: Write `newDeck.ts`**

The same planner, a different commit. **`importIntoNewDeck` stays in `useImport.ts`** — it is a
write that invalidates `["decks"]` on both success and failure, and its create-then-roll-back
logic belongs inside the mutation that does that invalidating. The preview calls it:

```tsx
export function NewDeckPreview({ list, resolved, tags, onDone, onBack }: DestinationPreviewProps) {
  const plan = useMemo(() => buildImportPlan(list, resolved, tags), [list, resolved, tags]);
  const [name, setName] = useState(list.suggestedName ?? "");
  const [formatKey, setFormatKey] = useState(DEFAULT_FORMAT);
  const [gameKey, setGameKey] = useState(ANY_GAME);
  const [commanderIds, setCommanderIds] = useState<string[]>([]);
  const { importIntoNewDeck } = useImport();

  const commit = async () => {
    const { deck, outcome } = await importIntoNewDeck.mutateAsync({
      name, formatKey, gameKey, items: toImportItems(plan, commanderIds),
    });
    onDone(`${deck.name} — ${outcome.cardsAdded} cards imported.`);
  };

  return (
    <>
      <Headline plan={plan} />
      <label className="flex items-center gap-2 text-sm">
        Deck name
        <input value={name} onChange={(e) => setName(e.target.value)}
          className={cn("h-8 flex-1 rounded-md border border-border bg-surface px-2", FOCUS)} />
      </label>
      <FormatSelect value={formatKey} onChange={setFormatKey} />
      <GameSelect value={gameKey} onChange={setGameKey} />
      <Tally categories={tallyOf(toImportItems(plan, commanderIds))} />
      <Commander plan={plan} chosen={commanderIds} onChoose={setCommanderIds} />
      <Problems plan={plan} blameSync={false} />
      {/* No mode radios: `merge` into a deck made one line ago is the only sensible mode —
          there is nothing to replace, and `merge` is the one that cannot clear anything if
          that ever stops being true. */}
      <CommitBar label="Create deck" onCommit={commit} onBack={onBack}
        disabled={name.trim() === ""} />
    </>
  );
}

export const newDeckDestination: ImportDestination = {
  key: "newDeck",
  label: "a new deck",
  Preview: NewDeckPreview,
};
```

`CommitBar` is the shared footer — Back, the Import button, an `aria-busy` while the mutation runs, and the `role="alert"` line for a refusal. Write it once in `shared/CommitBar.tsx`; all four destinations use it.

- [ ] **Step 5: Rename the dialog and the hook, and take a destination**

```bash
git mv src/features/transfer/import/ImportDeckDialog.tsx src/features/transfer/import/ImportDialog.tsx
git mv src/features/transfer/import/ImportDeckDialog.test.tsx src/features/transfer/import/ImportDialog.test.tsx
git mv src/features/transfer/import/ImportDeckDialog.stories.tsx src/features/transfer/import/ImportDialog.stories.tsx
git mv src/features/transfer/import/useDeckImport.ts src/features/transfer/import/useImport.ts
git mv src/features/transfer/import/useDeckImport.test.ts src/features/transfer/import/useImport.test.ts
```

`ImportDialog` takes `destinations: readonly ImportDestination[]` — non-generic, which is the whole point of the shape above — and draws a destination radio group on the source step when there is more than one. `ImportBody`'s step machine, its resolve call, its refusal handling and its Escape rung are untouched; the preview step becomes:

```tsx
const destination = destinations[chosen];
return <destination.Preview list={list} resolved={resolved.data.rows} tags={resolved.data.tags}
  onDone={report} onBack={() => setStep("source")} />;
```

Everything the old `ImportBody` knew about *decks* — the variant, the commander, the mode, the commit mutation — moves down into `DeckPreview` with it. What stays in the shell is the text, the file picker, the one `import_resolve` call, the step machine, and the read's own failure line.

- [ ] **Step 6: Run the contract test, then everything**

```bash
npm run test:run -- src/features/transfer/import/destination.test.ts
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
```

Expected: both green. The existing `ImportDialog.test.tsx` should pass with only its import paths changed — if any assertion had to change, the port changed behaviour and that is a bug in this task.

- [ ] **Step 7: Commit**

```bash
rm verify.log
git add -A
git commit -m "refactor(transfer): an ImportDestination interface, with deck and new deck on it"
```

---

### Task 13: Two bulk commits in Rust

**Files:**
- Modify: `src-tauri/src/collection.rs`
- Modify: `src-tauri/src/wishlist.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/lib/ipc.ts`
- Modify: `.storybook/fake/db.ts`

**Interfaces:**
- Consumes: the existing `add_entry(conn, &EntryInput)`, `set_quantity(conn, id, q)`, `add_wish(conn, &WishInput)`.
- Produces:
  - `collection_import_commit(items: Vec<CollectionImportItem>, mode: String) -> ImportCommitOutcome`
  - `wishlist_import_commit(items: Vec<WishlistImportItem>, mode: String) -> ImportCommitOutcome`
  - `ImportCommitOutcome { added: i64, updated: i64, removed: i64 }`
  - `ipc.collectionImportCommit(items, mode)`, `ipc.wishlistImportCommit(items, mode)`

- [ ] **Step 1: Write the failing Rust tests**

In `src-tauri/src/collection.rs`'s `#[cfg(test)] mod tests`:

```rust
#[test]
fn an_add_import_accumulates_quantities_on_the_grain() {
    let conn = test_db();
    let items = vec![item("card-1", 2, "nonfoil"), item("card-1", 3, "nonfoil")];
    let out = commit_import(&conn, &items, "add").unwrap();
    // Two items, one row: the file named the same grain twice and the copies add up.
    assert_eq!(out.added, 1);
    assert_eq!(out.updated, 1);
    assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 5);
}

#[test]
fn a_set_import_writes_the_files_quantity_rather_than_adding_to_it() {
    let conn = test_db();
    commit_import(&conn, &[item("card-1", 4, "nonfoil")], "add").unwrap();
    commit_import(&conn, &[item("card-1", 1, "nonfoil")], "set").unwrap();
    assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 1);
}

#[test]
fn a_foil_and_a_regular_copy_are_two_rows_in_both_modes() {
    let conn = test_db();
    commit_import(&conn, &[item("card-1", 1, "nonfoil"), item("card-1", 1, "foil")], "add")
        .unwrap();
    assert_eq!(quantity_of(&conn, "card-1", "nonfoil"), 1);
    assert_eq!(quantity_of(&conn, "card-1", "foil"), 1);
}

#[test]
fn a_refused_item_rolls_the_whole_file_back() {
    let conn = test_db();
    // A finish no CHECK will take. A half-imported collection is worse than a refused one.
    let items = vec![item("card-1", 1, "nonfoil"), item("card-1", 1, "glitter")];
    assert!(commit_import(&conn, &items, "add").is_err());
    assert_eq!(entry_count(&conn), 0);
}

#[test]
fn an_unknown_mode_is_refused_rather_than_defaulted() {
    let conn = test_db();
    assert!(commit_import(&conn, &[item("card-1", 1, "nonfoil")], "replace").is_err());
}
```

Write `item`, `quantity_of` and `entry_count` as small helpers beside them; `test_db` already exists in this module's tests — reuse it rather than writing a second one.

- [ ] **Step 2: Run them and watch them fail**

Run: `cd src-tauri && cargo test collection:: 2>&1 | tail -30`

Expected: FAIL — `cannot find function commit_import`.

- [ ] **Step 3: Write the collection commit**

```rust
/// One line of an import, after TypeScript has decided everything a *collection* decision is.
///
/// The condition is `Option` rather than defaulted here: an absent one means the file said
/// nothing, and the **dialog** is where the reader chose what that becomes. Defaulting it in two
/// places is how the preview and the write come to disagree.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionImportItem {
    pub card_id: String,
    pub quantity: i64,
    pub finish: String,
    pub condition: Option<String>,
    pub condition_original: Option<String>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub notes: Option<String>,
}

/// What a bulk import did. `removed` is the wishlist's alone — a `set` of 0 deletes a wish and
/// leaves a zero-quantity collection row — and it is 0 here rather than absent, so one shape
/// covers both commands.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportCommitOutcome {
    pub added: i64,
    pub updated: i64,
    pub removed: i64,
}

/// **One transaction for the whole file**, which is the whole reason this exists rather than the
/// page calling `collection_add` per line: a 500-row CSV would otherwise be 500 transactions, and
/// a failure halfway through would leave a collection nobody can reason about.
///
/// Added and updated are counted by the **row count before and after** rather than by a
/// grain lookup per item. `COLLECTION_GRAIN` is ten columns and a hand-written `WHERE` matching
/// it would be a second copy of the index's definition — the thing this module already warns
/// against at the `ON CONFLICT` target.
fn commit_import(
    conn: &Connection,
    items: &[CollectionImportItem],
    mode: &str,
) -> Result<ImportCommitOutcome, String> {
    if mode != "add" && mode != "set" {
        return Err(format!("`{mode}` is not an import mode. Use `add` or `set`."));
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in items {
        let input = EntryInput {
            card_id: item.card_id.clone(),
            finish: item.finish.clone(),
            condition: item.condition.clone(),
            condition_original: item.condition_original.clone(),
            quantity: item.quantity,
            tradelist_quantity: 0,
            purchase_price: item.purchase_price,
            purchase_currency: item.purchase_currency.clone(),
            acquired_at: item.acquired_at.clone(),
            acquisition_source: item.acquisition_source.clone(),
            serial_number: None,
            altered: false,
            signed: false,
            proxy: false,
            misprint: false,
            grading: None,
            tags: None,
            notes: item.notes.clone(),
        };
        if mode == "add" {
            add_entry(&tx, &input)?;
        } else {
            set_entry(&tx, &input)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let after: i64 = conn
        .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let added = after - before;
    Ok(ImportCommitOutcome {
        added,
        updated: items.len() as i64 - added,
        removed: 0,
    })
}
```

`set_entry` is `add_entry` with one clause changed — copy it and replace the `DO UPDATE SET quantity = quantity + excluded.quantity` with `DO UPDATE SET quantity = excluded.quantity`, keeping every other column's first-writer-wins rule and the verbatim `COLLECTION_GRAIN` conflict target.

Then the command:

```rust
#[tauri::command]
pub async fn collection_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<CollectionImportItem>,
    mode: String,
) -> Result<ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write_owned(&state, |c| commit_import(c, &items, &mode))
    })
    .await
    .map_err(|e| format!("the collection could not be written: {e}"))?
}
```

- [ ] **Step 4: Run the collection tests**

Run: `cd src-tauri && cargo test collection:: 2>&1 | tail -20`

Expected: PASS, 5 new tests.

- [ ] **Step 5: Write the wishlist's failing tests**

In `src-tauri/src/wishlist.rs`'s `#[cfg(test)] mod tests`:

```rust
#[test]
fn an_add_import_accumulates_on_the_wishlist_grain() {
    let conn = test_db();
    let out = commit_import(&conn, &[wish("oracle-1", 2), wish("oracle-1", 1)], "add").unwrap();
    assert_eq!(out.added, 1);
    assert_eq!(out.updated, 1);
    assert_eq!(quantity_of(&conn, "oracle-1"), 3);
}

#[test]
fn a_set_of_zero_removes_the_wish_rather_than_leaving_an_empty_one() {
    // The wishlist's own asymmetry, not a new rule: `wishlist_set_quantity(id, 0)` already
    // deletes, because a wish for nothing is not a wish.
    let conn = test_db();
    commit_import(&conn, &[wish("oracle-1", 2)], "add").unwrap();
    let out = commit_import(&conn, &[wish("oracle-1", 0)], "set").unwrap();
    assert_eq!(out.removed, 1);
    assert_eq!(wish_count(&conn), 0);
}

#[test]
fn a_wish_for_any_printing_is_a_different_row_from_a_wish_for_one() {
    let conn = test_db();
    commit_import(
        &conn,
        &[wish("oracle-1", 1), pinned_wish("oracle-1", "card-1", 1)],
        "add",
    )
    .unwrap();
    assert_eq!(wish_count(&conn), 2);
}

#[test]
fn a_refused_item_rolls_the_whole_file_back() {
    let conn = test_db();
    let items = vec![wish("oracle-1", 1), bad_finish_wish("oracle-2", 1)];
    assert!(commit_import(&conn, &items, "add").is_err());
    assert_eq!(wish_count(&conn), 0);
}

#[test]
fn an_unknown_mode_is_refused_rather_than_defaulted() {
    let conn = test_db();
    assert!(commit_import(&conn, &[wish("oracle-1", 1)], "replace").is_err());
}
```

Run: `cd src-tauri && cargo test wishlist:: 2>&1 | tail -30` — expected FAIL, `cannot find function commit_import`.

- [ ] **Step 6: Write the wishlist commit**

```rust
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistImportItem {
    pub oracle_id: Option<String>,
    /// `None` is a wish for **any printing** — what a wishlist usually means, and what the
    /// planner writes for a line that named no set. Not a looser version of a pinned wish:
    /// `WISHLIST_GRAIN` already treats the two as different rows.
    pub card_id: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    pub notes: Option<String>,
}

/// One transaction for the whole file — `collection_import_commit`'s rule, and its reasons.
///
/// `removed` is counted in the loop rather than derived, because a delete and an insert in one
/// file would cancel out in a before/after row count and report neither.
fn commit_import(
    conn: &Connection,
    items: &[WishlistImportItem],
    mode: &str,
) -> Result<ImportCommitOutcome, String> {
    if mode != "add" && mode != "set" {
        return Err(format!("`{mode}` is not an import mode. Use `add` or `set`."));
    }
    let before: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let mut removed = 0i64;

    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for item in items {
        let input = WishInput {
            oracle_id: item.oracle_id.clone(),
            card_id: item.card_id.clone(),
            quantity: item.quantity,
            preferred_finish: item.preferred_finish.clone(),
            notes: item.notes.clone(),
        };
        if mode == "add" {
            add_wish(&tx, &input)?;
            continue;
        }
        // `set`: find the row on the grain the add would have folded into, then write the
        // file's number onto it. `set_quantity` deletes at 0, which is what makes a file
        // saying `0 Sol Ring` remove that wish.
        let change = add_wish(&tx, &input)?;
        let after = set_quantity(&tx, change.id, item.quantity)?;
        if after.removed {
            removed += 1;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;

    let after: i64 = conn
        .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let added = (after - before) + removed;
    Ok(ImportCommitOutcome {
        added,
        updated: items.len() as i64 - added - removed,
        removed,
    })
}

#[tauri::command]
pub async fn wishlist_import_commit(
    state: tauri::State<'_, Arc<AppState>>,
    items: Vec<WishlistImportItem>,
    mode: String,
) -> Result<ImportCommitOutcome, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write_owned(&state, |c| commit_import(c, &items, &mode))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}
```

The `set` arm goes through `add_wish` first on purpose: it is the only code that knows the grain, and asking it to find-or-create and then correcting the quantity costs one extra statement per item and no duplicated `WISHLIST_GRAIN`. A wish the file sets to 0 that did not exist is created and immediately deleted — a no-op with a wasted insert, and the honest alternative would be a second copy of the grain.

Import `ImportCommitOutcome` from `crate::collection` rather than declaring a second one; one shape covers both commands.

Run: `cd src-tauri && cargo test wishlist:: 2>&1 | tail -20` — expected PASS, 5 tests.

- [ ] **Step 7: Register both commands and mirror them**

In `src-tauri/src/lib.rs`'s handler list, beside their siblings:

```rust
            collection::collection_import_commit,
            wishlist::wishlist_import_commit,
```

In `src/lib/ipc.ts`, the types and the two methods:

```ts
export interface ImportCommitOutcome {
  added: number;
  updated: number;
  /** The wishlist's alone: a `set` of 0 deletes a wish. Always 0 from the collection. */
  removed: number;
}

  collectionImportCommit: (items: CollectionImportItem[], mode: TransferImportMode) =>
    invoke<ImportCommitOutcome>("collection_import_commit", { items, mode }),
  wishlistImportCommit: (items: WishlistImportItem[], mode: TransferImportMode) =>
    invoke<ImportCommitOutcome>("wishlist_import_commit", { items, mode }),
```

with `export type TransferImportMode = "add" | "set";`

- [ ] **Step 8: Add the fake's handlers**

In `.storybook/fake/db.ts`'s `writeHandlers`, beside `collection_add` and `wishlist_add`, add `collection_import_commit` and `wishlist_import_commit` looping over the same in-memory operations those handlers already perform and answering `{ added, updated, removed }`.

- [ ] **Step 9: Verify both sides**

```bash
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cargo test 2>&1 | tail -20 && cd ..
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
```

Expected: green everywhere, no clippy warnings.

- [ ] **Step 10: Commit**

```bash
rm verify.log
git add -A
git commit -m "feat(transfer): bulk import commits for the collection and the wishlist"
```

---

### Task 14: The collection and wishlist destinations, and the import entry points

**Files:**
- Create: `src/features/transfer/import/destinations/collection.ts`, `CollectionPreview.tsx`, `collection.test.ts`
- Create: `src/features/transfer/import/destinations/wishlist.ts`, `WishlistPreview.tsx`, `wishlist.test.ts`
- Modify: `src/features/collection/CollectionPage.tsx`, `src/features/wishlist/WishlistPage.tsx`
- Modify: `src/lib/store.ts` (import defaults)

**Interfaces:**
- Consumes: `ImportDestination` (Task 12), `parse.ts`'s `extra` (Task 10), `ipc.collectionImportCommit` / `ipc.wishlistImportCommit` (Task 13), `normalizeCondition` from `@/lib/conditions`.
- Produces: `collectionDestination`, `wishlistDestination`, and store fields `importDefaults: { condition: Condition; finish: DeckFinish }` with `setImportDefaults`.

- [ ] **Step 1: Write the failing planner test**

Create `src/features/transfer/import/destinations/collection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { ImportResolveRow, ParsedLine, ParsedList } from "@/lib/ipc";
import { planCollectionImport } from "./collection";

const OPTIONS = { condition: "NM" as const, finish: null };

/** A whole `ParsedLine`. Four of `ParsedList`'s fields are easy to forget — `totalCards` and
 *  `suggestedName` are not optional. */
const line = (over: Partial<ParsedLine> = {}): ParsedLine => ({
  lineNumber: 1, raw: "1 Sol Ring", quantity: 1, name: "Sol Ring", setCode: null,
  collectorNumber: null, section: "deck", categoryName: null, finish: null, excluded: false,
  extra: {}, ...over,
});

const listOf = (...lines: ParsedLine[]): ParsedList => ({
  lines, issues: [],
  totalCards: lines.reduce((n, l) => n + l.quantity, 0),
  suggestedName: null,
});

const hit = (index: number, cardId: string): ImportResolveRow =>
  ({ index, hintMissed: false,
     matched: { cardId, oracleId: "o1", name: "Sol Ring", setCode: "LTC",
       collectorNumber: "285" } } as unknown as ImportResolveRow);

describe("planCollectionImport", () => {
  it("gives a line with no condition the reader's chosen default", () => {
    const plan = planCollectionImport(listOf(line({ quantity: 2 })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0]).toMatchObject({ cardId: "c1", quantity: 2, condition: "NM" });
  });

  it("lets a CSV column override the default, per row", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "LP" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].condition).toBe("LP");
  });

  it("normalises an EU grade and keeps what the file actually said", () => {
    const plan = planCollectionImport(
      listOf(line({ extra: { condition: "GD" } })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].condition).toBe("MP");
    expect(plan.items[0].conditionOriginal).toBe("GD");
  });

  it("folds a file that names the same grain twice, so `add` cannot double-count", () => {
    const plan = planCollectionImport(
      listOf(line({ quantity: 1 }), line({ lineNumber: 2, quantity: 2 })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(3);
  });

  it("keeps a foil apart from a regular copy, because the grain does", () => {
    const plan = planCollectionImport(
      listOf(line(), line({ lineNumber: 2, finish: "foil" })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(2);
  });

  it("leaves an unmatched line out of the items and names it in the plan", () => {
    const plan = planCollectionImport(
      listOf(line({ name: "Nonesuch" })),
      [{ index: 0, matched: null, hintMissed: false } as ImportResolveRow],
      OPTIONS,
    );
    expect(plan.items).toEqual([]);
    expect(plan.unmatched).toHaveLength(1);
    expect(plan.totalCards).toBe(0);
  });
});
```

And `wishlist.test.ts`, sharing those helpers via a local copy (they are six lines; a shared fixtures file for two test files is the wrong trade):

```ts
import { describe, expect, it } from "vitest";
import { planWishlistImport } from "./wishlist";

const OPTIONS = { finish: null };

describe("planWishlistImport", () => {
  it("wishes for any printing when the file named none", () => {
    // `1 Sol Ring` is a wish for the card. `card_id IS NULL` is what the wishlist's grain
    // already means by that, and it is a different wish from a pinned one rather than a
    // looser version of it.
    const plan = planWishlistImport(listOf(line()), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].cardId).toBeNull();
    expect(plan.items[0].oracleId).toBe("o1");
  });

  it("pins the printing when the file named one", () => {
    const plan = planWishlistImport(
      listOf(line({ setCode: "LTC", collectorNumber: "285" })), [hit(0, "c1")], OPTIONS);
    expect(plan.items[0].cardId).toBe("c1");
  });

  it("keeps a pinned wish and an any-printing wish apart", () => {
    const plan = planWishlistImport(
      listOf(line(), line({ lineNumber: 2, setCode: "LTC" })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(2);
  });

  it("folds two lines that name the same wish", () => {
    const plan = planWishlistImport(
      listOf(line({ quantity: 1 }), line({ lineNumber: 2, quantity: 2 })),
      [hit(0, "c1"), hit(1, "c1")],
      OPTIONS,
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0].quantity).toBe(3);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run test:run -- src/features/transfer/import/destinations/`

Expected: FAIL — cannot resolve `./collection`.

- [ ] **Step 3: Write the two planners**

```ts
/**
 * Where every line of a list is going when the destination is the collection.
 *
 * Pure, like `buildImportPlan` beside it and for the same reason: which printing is Rust's
 * question, and what a reader owns is a decision about their collection. The one thing this
 * knows that the deck's planner does not is that a **CSV can carry a condition** — so `extra`
 * is read first and `options` only fills the silence.
 */
export interface CollectionOptions {
  /** What a line that says nothing becomes. Chosen in the preview; never defaulted twice. */
  condition: Condition;
  finish: DeckFinish;
}

export interface CollectionPlan {
  items: CollectionImportItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParseIssue[];
  /** Copies that will actually land — not `ParsedList.totalCards`, which counts lines
   *  nothing resolved. */
  totalCards: number;
}

export function planCollectionImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  options: CollectionOptions,
): CollectionPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  // Keyed on the part of COLLECTION_GRAIN an import can produce. A file naming the same
  // grain twice is one intention said twice: under `add` it would double-count, and under
  // `set` the second line would silently win.
  const folded = new Map<string, CollectionImportItem>();

  list.lines.forEach((line, index) => {
    const row = byIndex.get(index);
    const matched = row?.matched ?? null;
    if (matched === null) {
      unmatched.push({ lineNumber: line.lineNumber, raw: line.raw, name: line.name });
      return;
    }
    if (row?.hintMissed === true) {
      hintMisses.push({ lineNumber: line.lineNumber, name: line.name, matched });
    }

    // The file's own word wins; `options` fills the silence. `normalizeCondition` folds the
    // EU scale into the NA one and hands back what the file actually said, which is exactly
    // what `condition_original` is for.
    const said = line.extra.condition;
    const { condition, original } =
      said === undefined
        ? { condition: options.condition, original: null }
        : normalizeCondition(said);
    const finish = line.finish ?? options.finish;
    const key = `${matched.cardId} ${finish ?? ""} ${condition}`;
    const seen = folded.get(key);
    if (seen !== undefined) {
      seen.quantity += line.quantity;
      return;
    }
    folded.set(key, {
      cardId: matched.cardId,
      quantity: line.quantity,
      // `nonfoil` is what Rust's CHECK takes for the regular copy; `null` is this app's word.
      finish: finish ?? "nonfoil",
      condition,
      conditionOriginal: original,
      purchasePrice: numberOrNull(line.extra.purchasePrice),
      purchaseCurrency: line.extra.purchaseCurrency ?? null,
      acquiredAt: line.extra.acquiredAt ?? null,
      acquisitionSource: line.extra.acquisitionSource ?? null,
      notes: line.extra.notes ?? null,
    });
  });

  const items = [...folded.values()];
  return {
    items,
    unmatched,
    hintMisses,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}

function numberOrNull(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}
```

`normalizeCondition` in `src/lib/conditions.ts` answers `{ condition, original }` — check its exact return shape before wiring it and match the names rather than these.

```ts
/**
 * The wishlist's planner.
 *
 * **Pins a printing only when the file named one.** `1 Sol Ring` is a wish for the card;
 * `1 Sol Ring (LTC) 285` is a wish for that printing. Reading the file's own specificity is the
 * only honest answer available, it costs no control, and `WISHLIST_GRAIN` already models the
 * two as different rows rather than one being a looser version of the other.
 */
export interface WishlistOptions {
  finish: DeckFinish;
}

export interface WishlistPlan {
  items: WishlistImportItem[];
  unmatched: UnmatchedLine[];
  hintMisses: HintMiss[];
  parseIssues: ParseIssue[];
  totalCards: number;
}

export function planWishlistImport(
  list: ParsedList,
  resolved: readonly ImportResolveRow[],
  options: WishlistOptions,
): WishlistPlan {
  const byIndex = new Map(resolved.map((row) => [row.index, row]));
  const unmatched: UnmatchedLine[] = [];
  const hintMisses: HintMiss[] = [];
  const folded = new Map<string, WishlistImportItem>();

  list.lines.forEach((line, index) => {
    const row = byIndex.get(index);
    const matched = row?.matched ?? null;
    if (matched === null) {
      unmatched.push({ lineNumber: line.lineNumber, raw: line.raw, name: line.name });
      return;
    }
    if (row?.hintMissed === true) {
      hintMisses.push({ lineNumber: line.lineNumber, name: line.name, matched });
    }

    const named = line.setCode !== null || line.collectorNumber !== null;
    const cardId = named ? matched.cardId : null;
    const finish = line.finish ?? options.finish;
    const key = `${matched.oracleId ?? ""} ${cardId ?? ""} ${finish ?? ""}`;
    const seen = folded.get(key);
    if (seen !== undefined) {
      seen.quantity += line.quantity;
      return;
    }
    folded.set(key, {
      oracleId: matched.oracleId,
      cardId,
      quantity: line.quantity,
      // `null` is "any finish" here, which is the wishlist's own meaning rather than the
      // collection's `nonfoil`.
      preferredFinish: finish,
      notes: line.extra.notes ?? null,
    });
  });

  const items = [...folded.values()];
  return {
    items,
    unmatched,
    hintMisses,
    parseIssues: list.issues,
    totalCards: items.reduce((n, i) => n + i.quantity, 0),
  };
}
```

- [ ] **Step 4: Write the two previews and their descriptors**

A preview owns its own options, its mode and its commit — see Task 12's interface note for why that is the shape rather than a generic `options`/`setOptions` pair.

```tsx
export function CollectionPreview({ list, resolved, onDone, onBack }: DestinationPreviewProps) {
  // The defaults live in the store so a reader importing box after box re-picks nothing.
  const defaults = useAppStore((s) => s.importDefaults);
  const setDefaults = useAppStore((s) => s.setImportDefaults);
  const [mode, setMode] = useState("add");
  const plan = useMemo(
    () => planCollectionImport(list, resolved, defaults),
    [list, resolved, defaults],
  );
  const commit = useImportCommit(() =>
    ipc.collectionImportCommit(plan.items, mode as TransferImportMode),
  );

  return (
    <>
      <p className="text-sm">
        {plan.totalCards === 1 ? "1 card" : `${plan.totalCards} cards`} will be added to your
        collection.
      </p>

      {/* The two facts a text list cannot carry, said before the reader commits rather than
          discovered afterwards in 300 rows they have to correct by hand. A CSV that carries
          the columns overrides these per row — see `planCollectionImport`. */}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <label className="flex items-center gap-2">
          Condition when the file doesn&apos;t say
          <select
            value={defaults.condition}
            onChange={(e) =>
              setDefaults({ ...defaults, condition: e.target.value as Condition })
            }
            className={cn("h-8 rounded-md border border-border bg-surface px-2", FOCUS)}
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABEL[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2">
          Finish when the file doesn&apos;t say
          <select
            value={defaults.finish ?? ""}
            onChange={(e) =>
              setDefaults({
                ...defaults,
                finish: e.target.value === "" ? null : (e.target.value as DeckFinish),
              })
            }
            className={cn("h-8 rounded-md border border-border bg-surface px-2", FOCUS)}
          >
            <option value="">Regular</option>
            <option value="foil">Foil</option>
            <option value="etched">Etched</option>
          </select>
        </label>
      </div>

      {/* No `replace`: the deck's version clears one variant of one deck, and the same word
          over a collection would empty a 3,000-card record from a 40-line paste. */}
      <ModeRadios
        modes={COLLECTION_MODES}
        value={mode}
        onChange={setMode}
        label="How to apply this file"
      />
      <ProblemList plan={plan} />
      <CommitBar
        label="Import"
        onCommit={async () => {
          const out = await commit();
          onDone(`${out.added} added, ${out.updated} updated.`);
        }}
        onBack={onBack}
        disabled={plan.items.length === 0}
      />
    </>
  );
}

export const COLLECTION_MODES: readonly ImportModeOption[] = [
  { key: "add", label: "Add these copies", hint: "Quantities add to what you already own." },
  { key: "set", label: "Set these quantities", hint: "The file's number replaces yours." },
];

export const collectionDestination: ImportDestination = {
  key: "collection",
  label: "your collection",
  Preview: CollectionPreview,
};
```

`WishlistPreview.tsx` is the same shape with the finish control alone, `planWishlistImport`, `ipc.wishlistImportCommit`, and one extra sentence under its mode radios:

```tsx
{mode === "set" && (
  <p className="text-sm text-dim">
    A line asking for 0 copies removes that wish.
  </p>
)}
```

because that is the wishlist's own asymmetry — `wishlist_set_quantity(id, 0)` deletes — and a reader is owed it before pressing Import rather than after.

Add the store slice beside `exportPrefs`:

```ts
  /** What a line that says nothing becomes. `NM` matches Rust's `DEFAULT_CONDITION`. */
  importDefaults: { condition: Condition; finish: DeckFinish };
  setImportDefaults: (defaults: { condition: Condition; finish: DeckFinish }) => void;
```

```ts
  importDefaults: { condition: "NM", finish: null },
  setImportDefaults: (importDefaults) => set({ importDefaults }),
```

`useImportCommit` is a small shared hook in `shared/CommitBar.tsx`'s file: a `useMutation` that invalidates `["collection"]` or `["wishlist"]` on both success and failure, the rule `useDeckImport` already applies to `["decks"]` — a refused write can still have been a database another surface has changed.

- [ ] **Step 5: Wire the Import buttons**

Mount `<ImportDialog destinations={[collectionDestination]} … />` from `CollectionPage.tsx` and `<ImportDialog destinations={[wishlistDestination]} … />` from `WishlistPage.tsx`, behind the Import buttons held back in Task 11 step 6. In `DeckEditor.tsx`, the existing import control now passes `[deckDestination, newDeckDestination]`.

- [ ] **Step 6: Verify**

Run: `npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log`

Expected: green.

- [ ] **Step 7: Commit**

```bash
rm verify.log
git add -A
git commit -m "feat(transfer): import into the collection and the wishlist"
```

---

### Task 15: Stories, documentation, and the live pass

**Files:**
- Modify: `src/features/transfer/export/ExportDialog.stories.tsx`, `src/features/transfer/import/ImportDialog.stories.tsx`
- Modify: `.storybook/fake/seeds.ts` if a seed is needed
- Create: `docs/reference/import-export.md`
- Modify: `CLAUDE.md` (the reference-docs table), `src/features/transfer/CLAUDE.md`

- [ ] **Step 1: Add a story per surface**

`ExportDialog.stories.tsx` gains `Collection` and `Wishlist` stories (a `surface` arg and rows built with the matching adapter), and one `EveryFieldOn` story on the collection in CSV — the tallest thing this dialog can draw, and the one the live pass photographs.

`ImportDialog.stories.tsx` gains `IntoCollection` and `IntoWishlist`.

- [ ] **Step 2: Run the story tests**

Run: `npm run test:run -- src/stories.test.tsx`

Expected: PASS. Story plays cannot be run mid-fan-out; if this task is being executed alongside siblings, run it again at fan-in.

- [ ] **Step 3: Write the reference doc**

`docs/reference/import-export.md` records: the seven formats and what each carries, the intersection rule with its table, the fold rule and why, the CSV header vocabulary (the `csvHeader` column of the registry), the four destinations with their modes and grains, and the sweep's page size with the measured round-trip count for a real collection. Take the measurement rather than repeating this plan's estimate — the repo's rule is that every number names the build it was taken on.

- [ ] **Step 4: Link it**

Add a row to the reference table in the root `CLAUDE.md`:

```markdown
| [import-export.md](docs/reference/import-export.md) | The seven formats, the field registry, the fold rule, the four import destinations |
```

- [ ] **Step 5: The live pass**

Launch the app per the `running-the-app` skill (take the lock). Then:

1. Open the collection, press Export, switch to CSV, switch **every** field on, open the preview. Confirm the panel is clamped to the window and both buttons are still reachable at a short viewport — jsdom cannot see this, and this dialog has already shipped one overflow bug.
2. Save the file, then press Import on the collection and open the file back. Confirm the condition column survived the round trip.
3. Import a plain-text list into the wishlist and confirm the un-pinned lines became any-printing wishes.

Record what the pass found in `docs/reference/decks-live-findings.md` — including anything still open.

- [ ] **Step 6: Verify, format, lint, commit**

```bash
npm run verify > verify.log 2>&1; grep -E "Test Files|Tests |error" verify.log
cd src-tauri && cargo fmt && cargo clippy --all-targets -- -D warnings && cd ..
rm verify.log
git add -A
git commit -m "docs(transfer): the import and export reference, stories and the live pass"
```

---

## Self-Review Notes

**Spec coverage.** §2 layout → Tasks 1, 2, 12. §3 `TransferCard` → Task 4. §4 registry and intersection → Task 5. §5.1 composing writers → Task 8. §5.2 sections needing a surface → Task 8. §5.3 folding → Tasks 6 and 8. §5.4 scope → Task 11. §6.1 pipeline → Task 12. §6.2 destinations and modes → Tasks 12, 13, 14. §6.3 wishlist pinning → Task 14. §6.4 defaults → Task 14. §6.5 one transaction → Task 13. §7 CSV → Tasks 7, 10. §8 Rust → Tasks 3, 13. §9 entry points → Tasks 11, 14. §10 persistence → Tasks 9, 14. §12 testing → every task, plus 15.

**One spec item deliberately deferred within a task rather than given its own:** the "fields switched off" sentence on the omission line (§5.2) is folded into Task 9, where the checkbox row that can cause it is built.
