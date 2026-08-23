# Remove Deck Driven Collection — Implementation Plan (PR 1 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the deck-driven collection feature entirely — the flag, the derived source, the settings panel, the five write refusals and every fence built on them — leaving the hand-built collection as the only collection there is.

**Architecture:** This is a **net deletion across 57 files and ~490 references**, not a rewrite. Every deck-driven site is one of exactly four shapes (§ "The four collapse rules" below), so the work parallelises into eight file-disjoint buckets that never touch each other's files. The existing test suite is the oracle: tests that only ever tested deck-driven are deleted with it, and every other test must stay green unchanged.

**Tech Stack:** Rust (rusqlite/SQLite, Tauri 2.11), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-23-collection-folders-design.md` — §4 is this plan; §1 is why.

## Global Constraints

- **This PR changes no schema.** `SCHEMA_VERSION` stays 23. The `app_meta` row `deck_driven_collection` is left on disk and deleted by the v24 rung in PR 2. Removing the reader is enough to remove the feature; a migration in this PR would make it un-revertable.
- **`collection_source.rs` is gutted, not deleted.** It keeps `with_write_owned`, `owns_printing`, `copies_of_printing`, `copies_of_oracle` and `owned_rowids`. It loses `LIVE`, `rows()` and `with_write_owned_if_derived`. Renaming the file is forbidden — case-collision risk on Windows, and a merge hazard across four stacked PRs.
- **No behaviour change for a reader who had the flag off**, which is every reader by default. That is the assertion the whole suite is making on this PR's behalf.
- **A reader who had the flag on is silently reverted** to their hand-built collection (spec §4). No banner, no migration, no one-time copy.
- Conventional commits: `refactor:` for the collapses, `chore:` for pure deletions, `docs:` for the documentation. Commit per bucket.
- **Never run two `npm run verify` at once** — concurrent runs fake ~18 Rust schema failures.
- `npm run verify` does **not** run `cargo fmt --check` or `cargo clippy`. Both run in CI and are the only reds a fully green verify can still produce. Run them before pushing.

## The four collapse rules

Every one of the ~490 references is one of these. An implementer who internalises these four needs no further instruction per site.

**Rule 1 — a two-arm function loses its derived arm.** The `if deck_driven::stored(conn) { derived } else { hand_kept }` shape keeps the `else` body and drops the branch. Example, `collection_source::with_write_owned_if_derived`:

```rust
// BEFORE
pub(crate) fn with_write_owned_if_derived<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    let answer = crate::sync::with_write(state, f);
    if answer.is_ok() && crate::deck_driven::stored(&crate::sync::lock_db_read(state)) {
        crate::index::lifecycle::invalidate_owned(state);
    }
    answer
}

// AFTER — the whole function goes; its 13 callers call `crate::sync::with_write` directly.
```

That collapse is correct **only while a deck write cannot move what the reader owns**, which is true for exactly this PR. PR 3 reintroduces ownership-moving deck writes (`collection_to_deck`, `deck_to_collection`) and those must call `with_write_owned`. Leave a one-line note at each of the 13 sites saying so, or PR 3 will silently ship a stale Owned facet.

**Rule 2 — a refusal disappears.** The five `if deck_driven::stored(conn) { return Err(DECK_DRIVEN) }` guards at the top of `collection.rs`'s writes, and the `DECK_DRIVEN` constant, are deleted outright. So is every test asserting the refusal.

**Rule 3 — a UI fence becomes unconditional.** `deckDriven ? <greyed> : <live>` keeps the live branch. The `deckDriven` prop, the `useDeckDrivenCollection()` call that fed it, and the field on the props interface all go with it. Do not leave a prop defaulting to `false` — an unread prop is the thing the next reader spends an hour on.

**Rule 4 — a test that only exists to test deck-driven is deleted.** A test whose name or body contains `deck_driven`/`deckDriven` and whose *only* subject is the flag goes. A test that merely *sets up* the flag alongside other assertions keeps its other assertions and loses the flag. When unsure, the tell is: does this test still assert something true about the app after the feature is gone? If yes, keep and trim.

## File Structure

Eight buckets. **No two buckets share a file.** Buckets A–H may all run at once except for the ordering note on A/B.

| Bucket | Files | Refs |
| --- | --- | --- |
| **A — Rust core** | `src-tauri/src/collection.rs` (42), `collection_source.rs` (22), `deck_driven.rs` (delete), `collection_decks.rs` (delete), `lib.rs` (3) | 76 |
| **B — Rust periphery** | `src-tauri/src/deck.rs` (24), `search.rs` (8), `wishlist.rs` (7), `deck_theory.rs` (7), `index/mod.rs` (5), `import.rs` (4), `reset.rs` (3), `wishlist_folders.rs` (1) | 59 |
| **C — Settings + ipc** | `src/features/settings/DeckDrivenPanel.{tsx,test.tsx,stories.tsx}` (delete), `SettingsPage.tsx`, `SettingsPage.stories.tsx`, `DangerZonePanel.{tsx,test.tsx}`, `useDataReset.{ts,test.ts}`, `src/lib/useDeckDrivenCollection.{ts,test.ts}` (delete), `src/lib/ipc.{ts,test.ts}` | 118 |
| **D — Collection UI** | `src/features/collection/` — `CollectionPage.{tsx,test.tsx,stories.tsx}`, `CollectionTable.{tsx,test.tsx}`, `CollectionSummary.tsx`, `CollectionFilterBar.{tsx,test.tsx}`, `AddToCollection.{tsx,test.tsx}`, `useCollection.ts`, `DeckCountCell.{tsx,test.tsx}` (delete) | 57 |
| **E — Card menu + deck hooks** | `src/features/card/cardMenu.{tsx,test.tsx}`, `useCardMenuDeps.ts`, `src/features/decks/useDeck{,s,Meta,Undo}.{ts,test.ts}` | 38 |
| **F — Transfer/import** | `src/features/transfer/import/ImportDialog.{tsx,test.tsx}`, `destinations/CollectionPreview.tsx`, `useImport.{ts,test.ts}` | 28 |
| **G — Storybook fake** | `.storybook/fake/db.ts`, `db.test.ts`, `seeds.ts`, `world.test.ts` | 66 |
| **H — Docs** | `CLAUDE.md`, `src-tauri/CLAUDE.md`, `.storybook/CLAUDE.md`, `docs/reference/{data-and-sync,decks-storage,storybook,decks-live-findings}.md`, `docs/reference/deck-driven-collection.md` (delete) | — |

**Ordering:** A defines the final `collection_source` API that B consumes. Both are given that API verbatim in the Interfaces blocks below, so they can run concurrently — but if the tree must compile mid-flight, run A first.

---

### Task 1: Bucket A — Rust core

**Files:**
- Delete: `src-tauri/src/deck_driven.rs`, `src-tauri/src/collection_decks.rs`
- Modify: `src-tauri/src/collection_source.rs`, `src-tauri/src/collection.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces — the final `collection_source` public API, which Bucket B codes against:
  ```rust
  pub(crate) fn with_write_owned<T>(state: &Arc<AppState>, f: impl FnOnce(&Connection) -> Result<T, String>) -> Result<T, String>;
  pub fn owns_printing(conn: &Connection, card_col: &str) -> String;
  pub fn copies_of_printing(conn: &Connection, card_col: &str) -> String;
  pub fn copies_of_oracle(conn: &Connection, oracle_col: &str) -> String;
  pub fn owned_rowids(conn: &Connection) -> String;
  ```
  **Gone:** `pub const LIVE`, `pub fn rows`, `pub(crate) fn with_write_owned_if_derived`.
  The four lookup helpers keep taking `&Connection` even though they no longer branch on it — changing their signature would touch every caller in Bucket B for no gain, and PR 2 changes them again for folders.
- Produces — `crate::collection` loses `pub const DECK_DRIVEN` and the five guards.
- Produces — exactly three Tauri commands are **unregistered**, at these lines of `src-tauri/src/lib.rs`, and Bucket C removes their `ipc.ts` wrappers:

  | `lib.rs` | Command |
  | --- | --- |
  | `:327` | `collection_decks::collection_row_decks` |
  | `:396` | `deck_driven::deck_driven_collection` |
  | `:397` | `deck_driven::set_deck_driven_collection` |

  Also delete `pub mod deck_driven;` (`lib.rs:9`) and the `collection_decks` module declaration.

- [ ] **Step 1: Delete the two modules and unregister their commands**

```bash
git rm src-tauri/src/deck_driven.rs src-tauri/src/collection_decks.rs
```

Then in `src-tauri/src/lib.rs` remove both `mod` declarations and every entry those modules contributed to `tauri::generate_handler![...]`. Record the exact command names removed — Bucket C needs them.

- [ ] **Step 2: Gut `collection_source.rs`**

Delete `LIVE`, `rows()` and `with_write_owned_if_derived` and their doc comments. Keep the five items in the Interfaces block. In each of the four lookup helpers, collapse Rule 1 — they currently pick a derived or a hand-kept SQL string; keep the hand-kept string. Delete the module's `#[cfg(test)]` fixtures that exist to compare the two arms (the doc at `:230-239` names them) and every test asserting the derived arm.

- [ ] **Step 3: Strip `collection.rs`**

Delete `pub const DECK_DRIVEN` and the five guards (Rule 2) at the tops of `add_entry`, `commit_import`, `set_quantity`, `update_entry`, `remove_entry`. In `list_entries`/`summarise`, collapse the `collection_source::rows` branch to the hand-built `collection_entries` query (Rule 1). Apply Rule 4 to the tests.

- [ ] **Step 4: Verify Rust compiles and its tests pass**

Run: `cd src-tauri && cargo test 2>&1 | tail -30`
Expected: compiles; failures only in Bucket B's files (`deck.rs`, `search.rs`, …), which is expected until Task 2 lands. **Report the count of tests selected** — a filter matching nothing exits 0 and proves nothing.

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/src
git commit -m "refactor(collection): delete the deck driven source and its refusals"
```

---

### Task 2: Bucket B — Rust periphery

**Files:**
- Modify: `src-tauri/src/deck.rs`, `search.rs`, `wishlist.rs`, `deck_theory.rs`, `index/mod.rs`, `import.rs`, `reset.rs`, `wishlist_folders.rs`

**Interfaces:**
- Consumes — the `collection_source` API in Task 1's Produces block. `LIVE`, `rows` and `with_write_owned_if_derived` no longer exist.

- [ ] **Step 1: Replace the 13 `with_write_owned_if_derived` call sites**

Each becomes `crate::sync::with_write(...)`. `deck.rs` imports it as `owned_if_derived` — remove that alias import. At each site add exactly this comment, because PR 3 depends on it:

```rust
// Plain `with_write`: a deck write moves nothing the reader owns. PR 3's
// `collection_to_deck`/`deck_to_collection` DO move ownership and must use
// `collection_source::with_write_owned` instead.
```

- [ ] **Step 2: Collapse the derived arms (Rule 1)**

- `deck.rs::attribute_owned` — drop the derived arm at `:3374-3381`, keep the allocation-based one. **`allocate_deck`'s early return on `deck_driven::stored` goes**, so the allocator now always runs. (The allocator itself is deleted in PR 3, not here.)
- `deck_theory.rs::owned_spare_sql` — drop the derived arm at `:259-264`.
- `search.rs`, `index/mod.rs`, `wishlist.rs`, `import.rs`, `wishlist_folders.rs` — each has a branch choosing between two SQL strings or two counts; keep the hand-kept one.
- `reset.rs` — `clear_collection` keeps `CollectionCleared.allocations` in this PR (the table still exists until PR 3).

- [ ] **Step 3: Apply Rule 4 to the tests in these files**

Delete `a_live_deck_is_fully_owned_when_deck_driven`, `a_theory_row_is_still_owned_nothing_when_deck_driven`, `an_inactive_category_is_owned_too_when_deck_driven` (`deck.rs:7546, 7568, 7596`) and their siblings elsewhere. Keep every test that survives the "still true after the feature is gone?" question.

- [ ] **Step 4: Verify**

Run: `cd src-tauri && cargo test 2>&1 | tail -30`
Expected: PASS, all tests. Report the selected count.
Then: `cargo fmt --all && cargo clippy --all-targets -- -D warnings`
Expected: clean. (Clippy caps function arguments at 7 — if a collapse pushes one over, that is a real finding, not a suppression.)

- [ ] **Step 5: Commit**

```bash
git add -A src-tauri/src
git commit -m "refactor(decks): drop the derived arms the deck driven source fed"
```

---

### Task 3: Bucket C — Settings and ipc

**Files:**
- Delete: `src/features/settings/DeckDrivenPanel.{tsx,test.tsx,stories.tsx}`, `src/lib/useDeckDrivenCollection.{ts,test.ts}`
- Modify: `src/features/settings/SettingsPage.tsx`, `SettingsPage.stories.tsx`, `DangerZonePanel.{tsx,test.tsx}`, `useDataReset.{ts,test.ts}`, `src/lib/ipc.{ts,test.ts}`

**Interfaces:**
- Consumes — the unregistered command names from Task 1 Step 1.
- Produces — `useDeckDrivenCollection` no longer exists. Buckets D, E and F all import it today and each removes its own import; **no bucket may create a shim or a stub in its place.**

- [ ] **Step 1: Delete the five files**

```bash
git rm src/features/settings/DeckDrivenPanel.tsx src/features/settings/DeckDrivenPanel.test.tsx src/features/settings/DeckDrivenPanel.stories.tsx src/lib/useDeckDrivenCollection.ts src/lib/useDeckDrivenCollection.test.ts
```

- [ ] **Step 2: Remove the panel from the settings page**

In `SettingsPage.tsx` delete the `DeckDrivenPanel` import (line 3), the `<DeckDrivenPanel deckDriven={deckDriven} />` element (line 75) and the `deckDriven` value that fed it. Do the same in `SettingsPage.stories.tsx`. Check for an orphaned `aria-labelledby` heading left behind by the removed `<section>`.

- [ ] **Step 3: Strip ipc**

In `src/lib/ipc.ts` remove the wrapper methods and types for `collectionRowDecks`, `deckDrivenCollection` and `setDeckDrivenCollection` (the camelCase wrappers over the three commands Task 1 unregistered). In `ipc.test.ts` remove their round-trip assertions. **A method left here for a command Rust no longer registers fails only at runtime**, so this step is the one that must be exact.

- [ ] **Step 4: Clean `DangerZonePanel` and `useDataReset`**

Apply Rule 3 — the reset copy currently says something different under a derived collection. Keep the hand-kept sentence.

- [ ] **Step 5: Verify**

Run: `npm run test:run -- src/features/settings src/lib/ipc.test.ts 2>&1 | tail -20`
Expected: PASS. Report the file and test counts — a path matching nothing passes vacuously.

- [ ] **Step 6: Commit**

```bash
git add -A src/features/settings src/lib
git commit -m "chore(settings): remove the deck driven collection panel and its hook"
```

---

### Task 4: Bucket D — Collection UI

**Files:**
- Delete: `src/features/collection/DeckCountCell.{tsx,test.tsx}`
- Modify: `src/features/collection/CollectionPage.{tsx,test.tsx,stories.tsx}`, `CollectionTable.{tsx,test.tsx}`, `CollectionSummary.tsx`, `CollectionFilterBar.{tsx,test.tsx}`, `AddToCollection.{tsx,test.tsx}`, `useCollection.ts`

**Interfaces:**
- Consumes — `useDeckDrivenCollection` is gone (Task 3). Remove the import; do not stub it.
- Produces — `CollectionTable`'s props lose `deckDriven`. The Actions column is **unconditionally** present with its delete button (Rule 3): the column existed conditionally only because a derived row's id is a `deck_cards.id` and cannot be deleted.

- [ ] **Step 1: Delete `DeckCountCell`**

```bash
git rm src/features/collection/DeckCountCell.tsx src/features/collection/DeckCountCell.test.tsx
```

It rendered the deck-names tooltip for a derived row via `collection_row_decks`, which Task 1 unregistered. PR 2 puts the row's **folder** in that column; nothing goes there in this PR.

- [ ] **Step 2: Apply Rule 3 across the six remaining components**

Every `deckDriven ?` ternary keeps its false branch. Remove the prop from each component's props interface and from every call site and story. `CollectionSummary.tsx`'s caption and `CollectionFilterBar.tsx`'s disabled state both have one.

- [ ] **Step 3: Apply Rule 4 to the tests**

`CollectionPage.test.tsx` is 1820 lines and holds the largest cluster. Delete the derived-mode describe blocks; keep every hand-built assertion.

- [ ] **Step 4: Verify**

Run: `npm run test:run -- src/features/collection 2>&1 | tail -20`
Expected: PASS. Report file and test counts.

- [ ] **Step 5: Commit**

```bash
git add -A src/features/collection
git commit -m "chore(collection): drop the derived-mode branches from the collection page"
```

---

### Task 5: Bucket E — Card menu and deck hooks

**Files:**
- Modify: `src/features/card/cardMenu.{tsx,test.tsx}`, `useCardMenuDeps.ts`, `src/features/decks/useDeck.{ts,test.ts}`, `useDecks.{ts,test.ts}`, `useDeckMeta.{ts,test.ts}`, `useDeckUndo.{ts,test.ts}`

**Interfaces:**
- Consumes — `useDeckDrivenCollection` is gone (Task 3).
- Produces — `CardMenuDeps` loses its `deckDriven` field. Bucket D and F both construct `CardMenuDeps`; **neither may keep passing it.**

- [ ] **Step 1: Make `Add to → Collection` unconditional**

In `cardMenu.tsx`, `collectionItem(target, addToCollection, deckDriven)` (`:373-413`) drops its third parameter and the `DECK_DRIVEN_REASON` branch at `:382-392`. Its remaining three branches — an explicit finish, a single available finish, a submenu of finishes — are unchanged. Delete `DECK_DRIVEN_REASON`. Update the call at `:258`.

```ts
// BEFORE
collectionItem(target, deps.addToCollection, deps.deckDriven ?? false)
// AFTER
collectionItem(target, deps.addToCollection)
```

- [ ] **Step 2: Remove `deckDriven` from `CardMenuDeps` and `useCardMenuDeps`**

Delete the field from the interface and the `useDeckDrivenCollection()` call that filled it.

- [ ] **Step 3: Clean the four deck hooks**

Each has one or two references — an invalidation key or a mode check. Apply Rules 1 and 3.

- [ ] **Step 4: Verify**

Run: `npm run test:run -- src/features/card src/features/decks/useDeck 2>&1 | tail -20`
Expected: PASS. Report counts.

Note: a greyed menu row's accessible name includes its reason, so `getByRole("menuitem", {name: "Collection"})` **fails** on a disabled row and reads as "the row is missing". If a test used a regex to tolerate that, it can now assert the exact name.

- [ ] **Step 5: Commit**

```bash
git add -A src/features/card src/features/decks
git commit -m "chore(card): un-grey Add to Collection now the derived mode is gone"
```

---

### Task 6: Bucket F — Transfer and import

**Files:**
- Modify: `src/features/transfer/import/ImportDialog.{tsx,test.tsx}`, `destinations/CollectionPreview.tsx`, `useImport.{ts,test.ts}`

**Interfaces:**
- Consumes — `useDeckDrivenCollection` is gone (Task 3); `CardMenuDeps.deckDriven` is gone (Task 5).

- [ ] **Step 1: Remove the three upstream fences**

`ImportDialog.tsx:195, 274, 352` each hide or refuse the collection destination under a derived collection. All three go (Rule 3). The destination radio fieldset at `:346-381` becomes unconditional.

- [ ] **Step 2: Un-fence `CollectionPreview`**

`:49, 71, 161` — the refusal banner and the disabled commit go. The condition/finish controls and the two-way `add`/`set` mode are unchanged.

- [ ] **Step 3: Clean `useImport.ts`**

One reference; apply Rule 1.

- [ ] **Step 4: Verify**

Run: `npm run test:run -- src/features/transfer 2>&1 | tail -20`
Expected: PASS. Report counts.

- [ ] **Step 5: Commit**

```bash
git add -A src/features/transfer
git commit -m "chore(transfer): let the collection import run unconditionally"
```

---

### Task 7: Bucket G — The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`, `db.test.ts`, `seeds.ts`, `world.test.ts`

**Interfaces:**
- Consumes — the three unregistered command names from Task 1. The fake implements the same command surface as Rust and must lose the same three.

- [ ] **Step 1: Remove the three fake command implementations and the flag from the fake's state**

`db.ts` carries 31 references — the flag, the derived row builder, and the three commands. Remove all of them. `.storybook/CLAUDE.md`'s fault list mentions deck-driven faults; those go in Task 8.

- [ ] **Step 2: Remove the deck-driven seeds and faults**

`seeds.ts` (16 refs) has seeds that exist only to demonstrate the derived mode.

- [ ] **Step 3: Verify**

Run: `npm run test:run -- .storybook 2>&1 | tail -20`
Expected: PASS. Report counts.

**Expect a fix round beyond these files.** A change to the fake's corpus has broken 25 story plays across five unrelated files before. Story plays cannot be run selectively during a fan-out — `stories.test.tsx` collects the whole tree — so any play breakage is the controller's to fix at fan-in, not this bucket's.

- [ ] **Step 4: Commit**

```bash
git add -A .storybook
git commit -m "chore(storybook): drop the deck driven flag, seeds and faults from the fake"
```

---

### Task 8: Bucket H — Documentation

**Files:**
- Delete: `docs/reference/deck-driven-collection.md`
- Modify: `CLAUDE.md`, `src-tauri/CLAUDE.md`, `.storybook/CLAUDE.md`, `docs/reference/data-and-sync.md`, `decks-storage.md`, `storybook.md`, `decks-live-findings.md`

- [ ] **Step 1: Delete the reference page and its table rows**

```bash
git rm docs/reference/deck-driven-collection.md
```

Remove its row from the reference table in the root `CLAUDE.md`. **Do not** add a `collection-folders.md` row yet — that page is written in PR 2, and a table row pointing at a file that does not exist is worse than no row.

- [ ] **Step 2: Strip the rule statements from the four `CLAUDE.md` files**

Each states a binding rule about the derived mode. Delete the rule, not just the phrase — a half-deleted rule reads as still binding.

- [ ] **Step 3: Update the reference docs**

`data-and-sync.md`, `decks-storage.md`, `storybook.md` and `decks-live-findings.md` each describe the mode. Remove those sections. **Re-count any list or total in the same commit** — a prose-only edit routes to neither CI job, so nothing goes red when a count rots.

Leave the design and plan documents for the shipped feature (`docs/superpowers/{specs,plans}/2026-08-22-deck-driven-collection*.md`) **in place**. They are history: they record a decision that was made and later reversed, and the new spec names them as superseded.

- [ ] **Step 4: Commit**

```bash
git add -A docs CLAUDE.md src-tauri/CLAUDE.md .storybook/CLAUDE.md
git commit -m "docs: remove the deck driven collection from the record"
```

---

### Task 9: Fan-in — verify, fix, ship

**This task is the controller's, not a subagent's.** Tests run once, here, after every bucket has reported.

- [ ] **Step 1: Confirm no reference survives**

```bash
grep -ril "deck_driven\|deckDriven\|deck-driven" --include="*.rs" --include="*.ts" --include="*.tsx" --include="*.md" . | grep -v node_modules | grep -v "docs/superpowers"
```
Expected: **no output.** Anything printed outside `docs/superpowers/` is a missed site. (`grep` calls some files binary on a stray NUL and then reports "no matches" as a lie — if `.storybook/fake/db.ts` is silent, confirm with `git grep` before believing it.)

- [ ] **Step 2: Full verify**

```bash
npm run verify > verify.log 2>&1; grep -iE "fail|error|passed|✓|✗" verify.log | tail -40
```
**Redirect to a file and grep it** — `npm run verify | tail` reports tail's exit 0 while tests fail. Expect a story-play fix round from Task 7.

- [ ] **Step 3: The two checks verify does not run**

```bash
cd src-tauri && cargo fmt --all --check && cargo clippy --all-targets -- -D warnings
```

- [ ] **Step 4: Drive the real window**

`npm run tauri dev`, take the app lock per the `running-the-app` skill, and confirm: the Settings page has no deck-driven row and no gap where it was; the Collection page's Actions column shows its delete button; `Add to → Collection` is not greyed; the collection import destination is offered. Per `live-ui-verification.md` — and note `cdp.mjs click` is a no-op on a cold pointer, so `hover --rest 200` first.

- [ ] **Step 5: Ship**

Use the `auto-pr` skill. The PR body must carry `Refs #215` and `Refs #209` — **not** `Closes`, because neither issue is resolved until PRs 2 and 3. Post the PR link as a comment on both issues.
