# Collection Search, the Own/Need Toggle and the Import Option — Implementation Plan (PR 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the deck builder two search tabs — **Collection Search by default** — so a reader builds from cards they own, and give deck import an "add these to my collection" option. This is what finally makes `collection_to_deck` reachable.

**Architecture:** Everything underneath already exists and is tested. `collection_to_deck` has been registered, tested and wired to nothing since PR 3; `CollectionQuery` already carries `folder_id` and `allocation`; the folder tree, the deck groups and `Recently removed` all shipped. **This PR is almost entirely frontend**, and its job is to connect a working backend to a reader.

**Tech Stack:** Rust (rusqlite/SQLite, Tauri 2.11), React 19 + TypeScript 6, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-08-23-collection-folders-design.md` — §7.2 and §7.4.

**Base:** `origin/main` once PR 3 (#219) has merged. **Branch fresh off it** — do not reuse a merged branch, because `pr-auto open` reports MERGED and silently creates no second PR.

## Global Constraints

- **No schema change.** `SCHEMA_VERSION` stays 25. If this PR needs a migration, something has gone wrong — stop and say so.
- `collection_to_deck(conn, entry_id, deck_id, category_id, quantity) -> MoveOutcome` and its `collectionToDeck` ipc wrapper already exist. **Do not rewrite them, and do not add a second path that moves a copy into a deck.**
- Never install `@types/node`. Never rename files. **Never run `prettier --write` over `src/`.**
- **Never run two `npm run verify` at once**; a background one gets killed mid-vitest, so shard it (`npx vitest run --shard=N/3`) in the foreground. `--reporter=basic` does not exist in vitest 4.
- Conventional commits. **Subagents do not commit** — parallel agents share one git index here.

## What the last three PRs taught, and this plan is shaped by

1. **Files no bucket owns are where every defect hid** — four times across three PRs. **Before dispatching, grep for every symbol being added or changed and check each hit against the bucket table.**
2. **A mock can encode a state the system no longer has and stay green forever.** PR 2's ghost row survived a full suite because a test mocked `removed: false`, which the backend could not return.
3. **Tested and unwired is the trap this PR exists to close.** PR 3 shipped `collection_to_deck` fully tested with no caller; nothing went red. **After each task, ask what calls this.**
4. **The live pass finds what the suite structurally cannot** — both of the last two PRs' worst findings came from it.
5. **Ask subagents to mutation-check behavioural tests.** Six defects were found that way, two in an agent's own just-written code.

## Ruling: `collection_to_deck` gets its history row in this PR

PR 3's review noted that `collection_to_deck` writes no `deck_audit` row, and deferred it because nothing called the command. **This PR is what calls it**, so the deferral expires here: filing a card into a deck from the collection is a deck write, and a deck write that leaves no history is a hole in the deck's own record. Its sibling `deck_to_collection` already writes one — copy that shape.

Undo stays absent for the same reason it is absent on the cut, and for once that asymmetry is *not* a problem: a reader who files the wrong card can simply cut it, which is one press and fully recorded.

## File Structure

Six buckets in two waves.

| Wave | Bucket | Files |
| --- | --- | --- |
| 1 | **A — the tab shell** | `src/features/decks/DeckSearchPanel.tsx` (+ test, stories) |
| 2 | **B — Collection Search** | `src/features/decks/CollectionSearchTab.tsx` (new, + test, stories), `useCollectionSearch.ts` (new), **`src/lib/ipc.ts` + `ipc.test.ts`** |
| 2 | **C — the own/need toggle** | `src/features/decks/NormalSearchAdd.ts` (new), `DeckEditor.tsx`, `useDeck.ts` (+ their tests) |
| 2 | **D — the import option** | `src/features/transfer/import/destinations/DeckPreview.tsx`, `NewDeckPreview.tsx`, `useImport.ts`, **`destination.ts`, `destinations/collection.ts` + its test** |

**A pre-flight sweep on 2026-08-23 found three of those files owned by nobody**, which is the shape of every defect on this feature so far — four unowned files in PR 1, and in PR 3 two files (`useDecks.ts`, `useDeckMeta.ts`) that were **not in the branch diff at all**, hiding both a stale rule and a missing invalidation. They are assigned above:

- **`src/lib/ipc.ts`** → Bucket B. `collectionToDeck` and `MoveOutcome` already exist there, but Collection Search is their first consumer and the `allocation` query field has never been sent by anything.
- **`destination.ts` and `destinations/collection.ts`** → Bucket D. `planCollectionImport` lives in the latter and Task 4 calls it a second time; if its signature needs an argument, that is Bucket D's to change and nobody else's.

`src/features/collection/CollectionPage.test.tsx` and `src/features/search/CardGrid.test.tsx` also mention these symbols, but only as fixtures. **Leave them; if either goes red it is a fan-in fix, not a bucket's.**
| 2 | **E — Rust: the history row** | `src-tauri/src/collection_alloc.rs` |
| 2 | **F — the fake and docs** | `.storybook/fake/db.ts`, `docs/reference/{collection-folders,import-export}.md`, `src/features/decks/CLAUDE.md` |

---

### Task 1: Bucket A — two tabs in the panel

**Files:** `src/features/decks/DeckSearchPanel.tsx` (+ its test and stories)

`DeckSearchPanel.tsx` is ~976 lines, of which most is doc comment. The header row at ~`:491-506` documents itself as having free space since the old "Add to" select was removed, and that is where the tabs go.

- [ ] **Step 1: Write the failing tests** — the panel opens on **Collection Search**; the tab strip is reachable and switches bodies; the choice survives a remount of the same deck.

- [ ] **Step 2: Build the strip**

`aria-pressed` over a `.map`, the shape `DeckEditor.tsx:2879` already uses for the Theory/Live switch — **not `role="tab"`**, which brings a keyboard contract this app does not implement elsewhere. The panel narrows to **206 px** (`MIN_PANEL_WIDTH_PX`), so the strip must wrap; check it at that width, not just at 1280.

- [ ] **Step 3: Keep each tab's data hook in its own component**

`OpenPanel` exists *solely* so `useCardSearch` is called conditionally (`:666-695`). The Collection tab's hook must live in its own sibling component for the same reason — **a hook called from a branch is a hook called conditionally**, and React will not have it.

- [ ] **Step 4: Verify** — `npx vitest run src/features/decks/DeckSearchPanel` and report file and test counts.

---

### Task 2: Bucket B — Collection Search

**Files:** create `src/features/decks/CollectionSearchTab.tsx` and `useCollectionSearch.ts` (+ tests, stories)

**Interfaces — consumes:** `ipc.collectionList` with `CollectionQuery`'s existing `folderId` and `allocation` fields, and `ipc.collectionToDeck`.

- [ ] **Step 1: Write the failing tests**

- The tab lists **collection rows**, not oracle cards: one row per printing/finish/condition, showing where each copy is filed.
- The **show all ↔ only unallocated** toggle. `Unallocated` means root, a user folder, or `Recently removed` — cards on the reader's desk. **Default: only unallocated**, because a copy in another deck is not one you can use.
- Adding calls `collectionToDeck` and the row leaves the unallocated list.
- **A copy in another deck's group is confirmed before it moves**, and the confirm **names that deck**.

- [ ] **Step 2: Build it**

Reuse `FilterBar` as the Normal tab does. The deck's format still opens the search (`hasLegalityData` gates it — `casual` is every deck's birth format and returns zero rows).

**The cross-deck confirm is the one piece of UX this PR must not get wrong.** The side effect lands on a deck the reader is *not looking at*: confirming takes the card out of that deck's list as well as its group. `MoveOutcome.fromDeck` carries the name **after** the fact too, so the confirmation and the result can say the same thing. Note this app's confirmations carry **no** `dialog` or `alertdialog` role — find it by its text.

- [ ] **Step 3: Do not be optimistic**

A move is one deliberate press. `src/lib/query.ts` caches 30 s, so a mounted query merely *marked* stale never refetches — invalidate the collection list, the folder summary and the deck, not just their roots. **PR 2 shipped a ghost row by getting exactly this wrong.**

- [ ] **Step 4: Verify** — `npx vitest run src/features/decks` and report counts.

---

### Task 3: Bucket C — the own/need toggle

**Files:** create `src/features/decks/NormalSearchAdd.ts`; modify `DeckEditor.tsx`, `useDeck.ts`

- [ ] **Step 1: Write the failing tests**

- A sticky two-state toggle, **"Adding: cards I own ↔ cards I need"**, remembered **per deck**.
- **cards I need** → today's behaviour exactly: a `deck_cards` row, no collection row, reads as missing.
- **cards I own** → **prefers to move a free copy the reader already has** into the deck's group, and only creates a new collection row in the group if none is free.

- [ ] **Step 2: The preference order is `allocate_deck`'s, kept deliberately**

Exact printing first, then another printing of the same **oracle** card, real copies before proxies, then entry id ascending. That order was the one piece of the deleted allocator worth keeping, and it is why a reader who used to let the allocator choose sees the same copy chosen now.

**Copies in another deck's group are never candidates here.** This path is silent, and taking another deck's card is only ever done through Task 2's confirm.

- [ ] **Step 3: Verify** — `npx vitest run src/features/decks` and report counts.

---

### Task 4: Bucket D — the import option

**Files:** `src/features/transfer/import/destinations/DeckPreview.tsx`, `NewDeckPreview.tsx`, `useImport.ts`

- [ ] **Step 1: Write the failing test** — ticking the box files the imported cards into **that deck's group**, so the decklist and the group agree immediately and the copies are correctly unavailable to other decks.

- [ ] **Step 2: State lives in the preview, never on `DeckImportInto`**

That interface is identity-only, and `deckDestination` is memoised on what it closes over — a presentational field there remounts the step under the reader. Put it beside `DeckPreview`'s existing `mode` state (~`:109`), in the scroller at ~`:185-197` next to `<Mode>`.

- [ ] **Step 3: Two commands, one press**

`useImport.ts`'s `importIntoNewDeck` (~`:175-196`) is the precedent, hand-rolled rollback included. Invalidation is the **union** of the deck write roots and the collection's.

**The collection items come from calling `planCollectionImport` a second time over the same `resolved` rows** — it is already pure — rather than adapting deck items across, because the grains differ. Its fold key is the full grain since PR 2, so this cannot write a second all-defaults row beside an altered one.

- [ ] **Step 4: Verify** — `npx vitest run src/features/transfer` and report counts.

---

### Task 5: Bucket E — the history row

**Files:** `src-tauri/src/collection_alloc.rs`

- [ ] `collection_to_deck` writes a `deck_audit` row, the way `deck_to_collection` already does. Test first; then break it and confirm the test catches the miss.

---

### Task 6: Bucket F — the fake and the docs

**Files:** `.storybook/fake/db.ts`, `docs/reference/{collection-folders,import-export}.md`, `src/features/decks/CLAUDE.md`

- The fake must answer `collection_list`'s `allocation` filter and `collection_to_deck`'s audit row.
- **Re-count `db.test.ts`'s method-count sweep** and record the move in its archaeology comment — it went 64 → 66 in PR 3.
- `collection-folders.md` gains the Collection Search tab and **loses the sentence saying `collection_to_deck` has no caller**. `import-export.md` gains the new option.
- **PR 3's docs say a cut cannot be put back in one press because `collection_to_deck` has no UI.** That stops being true here — correct it, and say what the recovery now costs.

---

### Task 7: Fan-in

- [ ] **Grep for unwired code.** For each new command or wrapper, ask what calls it. That is the trap this PR exists to close.
- [ ] **Full verify, sharded.** Redirect to a file and grep it — `| tail` reports tail's exit 0 while tests fail.
- [ ] **Whole-diff review**, one fix wave, one scoped re-review.
- [ ] **Drive the real window.** Open a deck, add a card from Collection Search and watch it leave the unallocated list; take a copy from another deck and read the confirm; flip the own/need toggle and check both paths; import a decklist with the box ticked. Take the app lock; **release it when done**.
- [ ] **Ship** with `auto-pr`. Both issues are already closed, so the body carries `Refs #215, Refs #209`.
