# Purchase price, and a condition that can say nothing

Issue [#361](https://github.com/Msgaihede/mtg-grimoire/issues/361). Branch
`worktree-track-purchase-price`.

## What is already there, and what is not

`collection_entries.purchase_price` and `.purchase_currency` have existed since the v1 rung.
They are carried by `EntryInput`, `EntryPatch`, `CollectionRow`, the fold, the reconcile, the
folder move, the sync capture, the plain-text mirror and both export writers. **The storage is
not the work.** What is missing is every way for a reader to put a number in one:

- `ipc.collectionUpdate` / `collection_update` exist on both sides of the wire and have **no
  caller in `src/`** — only `ipc.test.ts`. There is no way to correct a copy after adding it.
- `AddToCollection` sends three fields and has no price control.
- `condition` is `NOT NULL DEFAULT 'NM'` with a five-value CHECK. A reader who does not know
  or does not care what grade a copy is has no way to say so; the app records Near Mint for
  them, which is the best grade on the scale.

## The two decisions

**A price is optional and never guessed.** The field opens blank. The current marketplace's
price for the chosen printing *and finish* rides as the input's `placeholder` — a hint the
reader can read and retype, never a value the app stores on their behalf. Nothing is written
that the reader did not type.

**A condition can say nothing, and that is the new default.** A sixth grade joins the scale:
storage code `NONE`, label **"Not set"**. Every write that does not state a grade lands on it —
the add popup opens on it, the two menu quick-adds record it, an import line whose file is
silent becomes it. **Existing rows are not touched**: a database full of `NM` stays full of
`NM`, because nobody can tell which of those the reader meant and which the app chose for them.

## The sentinel, and why not NULL

`condition` is the third term of `idx_collection_grain`, a UNIQUE index. SQLite treats two
NULLs as distinct in a unique index, so a nullable `condition` would make every ungraded add a
brand-new row instead of folding onto the one already there — a reader pressing `+` four times
would end with four rows of one copy. A sentinel string folds correctly and needs no special
case anywhere in the fold, the reconcile or the sync. `NONE` it is.

`NONE` sorts **last** in the grade order (`NM LP MP HP DMG NONE`), so the scale stays a scale
and the ungraded pile lands at the end of it. It sorts **first** in the dropdowns, because
there it is the default rather than a grade.

`NONE` leaves the app as an **empty** condition cell in every export: the row → `TransferCard`
mapping turns it into `null`, and `fields.ts` already writes `c.condition ?? ""`. That is also
what makes it round-trip — an empty cell is exactly what the importer reads as "the file did
not say", which is now `NONE` again.

## Tasks

Each task owns the files listed under it and touches **no others**. Do not run test suites and
do not run any git command; the tree is shared and the index is shared.

---

### T1 — Schema v35

Owns: `src-tauri/src/schema.rs`

1. `USER_SCHEMA_VERSION` 34 → 35, and the doc block above it gets a line for the new rung, in
   the voice the 27/28/29 lines are written in.
2. A `if v < 35 {` rung at the bottom of `migrate_user`, above the unconditional clock repair.
   SQLite cannot alter a CHECK, so this is a **table rebuild**. Copy the shape of the v8
   `deck_cards` rebuild (`schema.rs` ~1737–1800) exactly: build `collection_entries_v35`,
   `INSERT … SELECT` every column **including `id`** so row ids survive, `DROP TABLE
   collection_entries`, `ALTER TABLE … RENAME TO`, then recreate all five indexes as
   **literals** (never interpolated from `COLLECTION_GRAIN` — that constant is for head, this
   step is history the day it ships):
   - `idx_collection_grain`, `idx_collection_card`, `idx_collection_review`,
     `idx_collection_folder`, `idx_collection_entries_uid`
   The new column line is
   `condition TEXT NOT NULL DEFAULT 'NONE' CHECK (condition IN ('NONE','NM','LP','MP','HP','DMG'))`.
   Every other column is the **head** shape verbatim, `folder_id` and `sync_uid` included.
   `PRAGMA main.user_version = 35;` as a literal, then `tx.commit()`.
3. `USER_SCHEMA_SQL` (the head literal, ~3333): same CHECK and DEFAULT.
4. **Do not touch** the v1 rung (~1270) or the v6 test fixture (~9134). Both are frozen history.
5. `the_finish_and_condition_enums_are_enforced_by_the_database` (~7868): `NONE` is now
   storable; a junk grade still is not.
6. New tests: a database built at 34 with `NM` and `LP` rows climbs to 35 keeping both grades,
   keeping its ids, and now accepting a `NONE` insert; and a row with `folder_id` set survives
   the rebuild with its filing intact.

**Note for the rebuild:** `deck_allocations` was dropped at v25, so nothing references
`collection_entries(id)` at head. `PRAGMA foreign_keys` is a documented no-op inside a
transaction and `migrate_user` runs in one — leave it exactly as it is, as the v8 comment says.

---

### T2 — The Rust vocabulary

Owns: `src-tauri/src/collection.rs`

1. `pub const CONDITIONS: [&str; 6] = ["NONE", "NM", "LP", "MP", "HP", "DMG"];`
2. `pub const DEFAULT_CONDITION: &str = "NONE";` — and its doc says what changed: an unmarked
   card is no longer *assumed* to be anything.
3. `pub const CONDITION_NOT_SET: &str = "NONE";` — the name the rest of the crate imports when
   it means the sentinel rather than the default. (They are the same string today and the two
   words are not the same idea; T3 imports this one.)
4. `COLLECTION_SORTS`' `finish` key: the `CASE` runs `NM 0, LP 1, MP 2, HP 3, DMG 4, NONE 5`
   in both the `asc` and the `desc` string. `ELSE 5` stays as the catch-all it already is —
   spell `NONE` anyway, because an `ELSE` that happens to be right is not a rule.
5. `CollectionRow.condition`'s doc (~1429) currently argues that a reader who never stated a
   grade is represented by `condition_original` being `None`. That is no longer true and the
   paragraph has to say so.
6. Tests: an add with no condition lands `NONE`; `NONE` passes `valid_condition`; a `NONE` row
   and an `NM` row of one printing are two rows, not one; the `finish` sort puts `NONE` after
   `DMG`.

---

### T3 — The rest of the Rust tree

Owns: everything under `src-tauri/src/` **except** `schema.rs` and `collection.rs` — in
practice `transfer/`, `mirror/`, `card.rs`, `deck_pull.rs`, `deck_quick_add.rs`,
`collection_folders.rs`, `collection_source.rs`, `collection_alloc.rs`, `reconcile.rs`,
`search.rs`, `web/route.rs`, `sync_engine/`, `reset.rs`, `wishlist*.rs`.

1. **The export mapping.** Where a collection row becomes a `TransferCard`
   (`src-tauri/src/transfer/card.rs` and whatever builds its rows), `CONDITION_NOT_SET` maps to
   `None`. A not-set copy exports as an empty Condition cell, exactly as a deck row does.
   Test it: a `NONE` row round-trips to an empty cell and nothing else changes.
2. Sweep the rest for anything that assumes five grades or that `NM` is the default. Test
   fixtures spelling `'NM'` are fine and stay — `NM` is still a grade.
3. `T2` supplies `CONDITION_NOT_SET`; it will exist. Import it, do not spell `"NONE"`.

---

### T4 — The TypeScript vocabulary, the store, and transfer

Owns: `src/lib/conditions.ts`, `src/lib/conditions.test.ts`, `src/lib/store.ts`,
`src/features/transfer/**` (all of it: `TransferCard.ts`, `fields.ts`, `fixtures.ts`,
`import/`, `export/`, and their tests and stories).

1. `CONDITIONS = ["NONE", "NM", "LP", "MP", "HP", "DMG"]` — **`NONE` first**, and the existing
   comment about why this list is not alphabetical needs a second half explaining why the
   default leads a scale it is not part of.
2. `CONDITION_LABEL.NONE = "Not set"`.
3. `export const CONDITION_NOT_SET: Condition = "NONE";`
4. `MENU_CONDITION = CONDITION_NOT_SET`, and its doc block — which currently argues at length
   for Near Mint as the one decision a menu makes on the reader's behalf — is now the opposite
   argument: a menu makes **no** decision, because there is finally a way to record that.
5. `normalizeCondition`: silence (`null`, `undefined`, blank) → `{ condition: "NONE", original:
   null, matched: true }`. An unrecognised spelling → `{ condition: "NONE", …, matched: false }`.
   The doc paragraph about the NM default erring in the owner's favour is replaced by the
   reason it no longer has to. Add `none`, `unset` and `not set` to `SYNONYMS` → `NONE`.
6. `store.ts`: `importDefaults.condition` default `"NM"` → `"NONE"`. **Leave any persisted
   value alone** — a reader who already has `NM` stored chose it, or lived with it, and a
   migration that silently changes what their next import records is worse than the
   inconsistency. Say that in a comment.
7. `TransferCard.ts`: where a `CollectionRow` becomes a `TransferCard`, `CONDITION_NOT_SET` →
   `null`. This is the TS half of T3.1 and the two must agree byte for byte — the golden fence
   is what will tell you if they do not.
8. `import/destinations/collection.ts`: the planner already prefers the file's word and falls
   back to `options.condition`. Check the blank-cell path — `normalizeCondition("")` answers
   `matched: true`, so a blank cell currently takes the function's fallback rather than the
   dialog's. With both now `NONE` that is no longer a visible difference, but say which one
   wins in a comment so the next edit does not have to re-derive it.
9. `CollectionPreview.tsx`: the "Condition when the file doesn't say" dropdown picks its
   options up from `CONDITIONS` and needs no change beyond opening on `NONE`. Check the label
   still reads right with "Not set" as an option in it.
10. **Do not regenerate the golden corpus.** `__golden__/corpus.json` holds no not-set row and
    must not grow one in this PR — the fence is there to catch drift between the two writers,
    and changing the corpus in the same commit as the writers is how a fence stops fencing.
    Cover the new mapping with unit tests on both sides instead.

---

### T5 — The add popup

Owns: `src/features/collection/AddToCollection.tsx`, `.test.tsx`, `.stories.tsx`

1. `useState<Condition>("NM")` → `MENU_CONDITION` (imported, not spelled). The dropdown opens
   on "Not set".
2. A **Price** field below Condition, collection mode only, beside the existing label/Dropdown
   pair and styled like it. A `<input type="text" inputMode="decimal">` — not `type="number"`,
   whose spinners and locale-dependent decimal handling are a worse fit for money. Blank by
   default. Parse with a small local helper: empty or unparseable → send nothing.
3. The **placeholder** is the current marketplace's price for `target.cardId` at the selected
   `finish`, formatted with `formatPrice`. Get it the way `CardTextDialog`, `LegalityDialog`
   and `OracleTagsDialog` already get a card: `useQuery` on `cardDetailKey(cardId,
   marketplace.id)` with `ipc.cardDetail`, so a card whose pane the reader already opened costs
   nothing. `AnchoredPopup` mounts `AddForm` with the panel, so the query fires on open and not
   before. No placeholder while it is in flight or if it answers `null` for that finish — an
   empty placeholder, never a `0`.
   **The placeholder tracks the finish chips**: switching to Foil must change the hint, or the
   hint is a lie about the row being written.
4. On submit, when a price was typed: `purchasePrice: <number>` and `purchaseCurrency:
   marketplace.currency.toUpperCase()` (`"USD"` / `"EUR"` — the spelling already in the column).
   When it was not: neither field, so the backend's `coalesce` leaves the row's own price alone.
5. The success line stays exactly as it is. A price is not worth a second sentence.
6. Stories and tests: the popup opens on "Not set"; a typed price reaches `collectionAdd`; a
   blank one sends neither price field; the placeholder follows the finish.

---

### T6 — Editing a copy

Owns: new `src/features/collection/EditCopy.tsx` (+ `.test.tsx`, `.stories.tsx`),
`src/features/card/cardMenu.tsx`, `src/features/card/cardMenu.test.tsx`,
`src/features/collection/CollectionPage.tsx`, `.test.tsx`, `.stories.tsx`

1. A dialog — `Dialog`, the app's own — editing **condition** and **purchase price** for one
   `collection_entries` row. Nothing else in this PR: quantity is the table's stepper, filing
   is Move to, and the acquisition columns have no issue asking for them yet.
2. It writes through `ipc.collectionUpdate(id, patch)`, which has waited for a caller since it
   was written. Send only what changed. **Clearing a price is not possible** and the dialog
   must not pretend otherwise: `EntryPatch` is `coalesce(?n, column)` throughout, so an absent
   field means "leave it" and there is no value that means "make it null". Say so where the
   reader can see it, or leave the field non-clearable — your call, but do not ship a control
   that silently does nothing. Note the gap in the reference doc (T8's job — tell them).
3. `cardMenu.tsx` gets an optional dep in `CardMenuDeps`, `editCopy?: (entryId: number) =>
   void`, and a menu row fenced on `target.entryId` — the single-row fence
   `moveToFolder` already documents. A tile standing for several rows (`entryIds`) offers no
   edit: which copy would it be about?
4. `CollectionPage.tsx` supplies it, the way it already supplies `pickCopies`, and holds the
   dialog's open state in its existing `Panel` union rather than a new boolean — the union's
   own doc says why.
5. Invalidate `["collection"]` on success, and `["cards", "search"]` only if you changed
   something a badge draws (you did not — a price and a grade are not on a badge). Do not
   invalidate `["decks"]`: no deck's arithmetic reads a grade or a price.

---

### T7 — Every surface that draws a condition

Owns: `src/features/collection/CollectionTable.{tsx,test.tsx,stories.tsx}`,
`src/features/collection/PickCopies.*`, `src/features/collection/useCollection.{ts,test.ts}`,
`src/features/decks/**`, `src/features/search/FilterBar.tsx`,
`src/features/search/SearchPage.test.tsx`, `src/features/card/useCardMenuDeps.ts`,
`src/features/card/CardDetailModal.tsx`, `src/App.test.tsx`,
`src/lib/dndAccessibility.test.tsx`, `src/features/wishlist/WishlistPage.test.tsx`

1. `CollectionTable`'s `Finish · condition` cell and its `copyLabel` helper currently print
   both halves always, on the argument that `condition` is `NOT NULL DEFAULT 'NM'` so the
   "no grade" arm could not be reached. **It can now.** A not-set row prints the finish alone
   — `Foil`, not `Foil, NONE` and not `Foil, —`. The comment that argues the old way has to
   argue the new one. `conditionLabel` keeps working through `CONDITION_LABEL` and needs
   nothing.
2. `FilterBar`'s Condition tray and `useCollection`'s `conditions` filter pick their options up
   from `CONDITIONS`, so "Not set" becomes a filter for free — which is the right answer, and
   check the chip label reads properly (`Condition: NONE` in the chip is wrong; the chip
   currently joins raw codes).
3. `useCardMenuDeps.ts` and `useDeck.ts` already import `MENU_CONDITION`; T4 changes what it
   is. Fix the tests that assert `"NM"` for a menu quick-add — they are asserting the old
   decision, not a regression.
4. `CardDetailModal.tsx` ~286 documents "the condition a one-press add records". Update the
   sentence.
5. `PullFromCollectionDialog` and `CollectionSearchTab` label a raw grade through
   `CONDITION_LABEL` and need nothing but a look.

---

### T8 — The Storybook fake

Owns: `.storybook/fake/**`

The fake is the Rust backend's second implementation for the workbench and has to agree with it:
`collection_add`, `collection_import`, `collection_update`, the fold and
`collectionRowsForTransfer`. Default condition `NONE`, the six-grade list, `NONE` → `null` on
the transfer mapping, and the `NONE`-sorts-last rule in whatever orders a collection list.
Seeds keep their explicit grades; add one not-set row so the new states have something to draw.

---

### T9 — The record (after fan-in, not during)

`docs/reference/data-and-sync.md` (the schema ladder gets its v35 line),
`docs/reference/import-export.md` (the empty-cell round trip),
`docs/reference/collection-folders.md` if it names the grain,
`src-tauri/CLAUDE.md` and `src/features/transfer/CLAUDE.md` if either states the five grades.

Also worth writing down: **sync does not gate on schema version**, so a v35 device pushing a
`NONE` row to a v34 device fails that device's CHECK. That is true of every rung this repo has
ever shipped — `collection_folders.locked` at v34 has the same shape — and it is not this PR's
to fix. It is worth one sentence in `docs/reference/sync.md` so the next person does not
discover it the hard way.
