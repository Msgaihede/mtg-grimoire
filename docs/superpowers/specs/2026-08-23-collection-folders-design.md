# Collection folders, deck groups, and the end of the allocator

**Date:** 2026-08-23. **Issues:** [#215](https://github.com/Msgaihede/mtg-grimoire/issues/215)
(folders on the collection page), [#209](https://github.com/Msgaihede/mtg-grimoire/issues/209)
(a holding area for cards taken out of Live decks). Supersedes
[the deck-driven collection design](2026-08-22-deck-driven-collection-design.md) and the
reference page it produced.

## 1. The model, in one line

**The collection folder tree is the physical ledger of where every card sits.**

A card is in a deck because its collection row is filed in that deck's group — not because a
claim table says so. `deck_allocations` and `allocate_deck`/`allocate_every_deck` are deleted;
the folder answers the question they were computing.

Three consequences fall straight out of that sentence, and everything in this spec is one of
them:

1. **Exclusivity is a fact rather than arithmetic.** A copy filed in Deck A's group is not in
   the available pool, so no other deck can see it or take it without saying so out loud.
2. **Owned/missing survives, with the same numbers.** A live deck card is owned to the extent
   *its own group* holds copies of that **oracle** card — so a Bolt is still a Bolt — and
   missing is the remainder. No ledger, no reconciliation pass, no run list.
3. **`is_built` loses its only mechanical job and is retired.** It meant "this deck is on a
   table, so its claims block other decks" (`deck.rs:3454`). Once copies physically sit in a
   group, every deck blocks by construction.

### What this costs, stated up front

After the migration, owned/missing is exactly as accurate as the reader's filing. A card they
own but have not filed into a deck's group reads as **missing** in that deck. The old allocator
guessed automatically; this model asks them to say. That is the intended trade — it is what
makes exclusivity visible and draggable — and it is the change most likely to feel like a
regression on day one. The v24 backfill (§6) exists so that it is not one for anybody who had
allocations already.

## 2. Scope

**In:** the removal of deck-driven collection; nested collection folders; a locked group per
deck; a global `Recently removed` folder; two tabs in the deck builder's search panel;
exclusive allocation through group membership; nested folder targets in the card menu;
`Move to → folder` for collection rows; an "add cards to collection" toggle on deck import;
three duplicate/quantity fixes.

**Out:** folders in import and export formats (the seven formats carry cards, and a folder is
not one — the same decision `wishlist-folders.md` records); per-folder price summaries beyond
what §7 lists; any change to the wishlist's own folders; sharing one card between two decks
(explicitly refused by the model).

## 3. Schema v24

`SCHEMA_VERSION` moves 23 → 24. One rung, ten statements, in this order.

### 3.1 `collection_folders`

Copies `wishlist_folders` verbatim, including **both `ON DELETE` actions and the reason each
points the way it does** — `parent_id` CASCADE onto its own table (a folder inside a deleted
folder has nowhere else to be), `collection_entries.folder_id` SET NULL (a folder is a filing
decision; the cards outlive it).

```sql
CREATE TABLE IF NOT EXISTS collection_folders (
    id INTEGER PRIMARY KEY,
    parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user','deck','removed')),
    deck_id INTEGER REFERENCES decks(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((kind = 'deck') = (deck_id IS NOT NULL))
);
ALTER TABLE collection_entries ADD COLUMN folder_id INTEGER
    REFERENCES collection_folders(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_removed
    ON collection_folders(kind) WHERE kind = 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_folder_deck
    ON collection_folders(deck_id) WHERE deck_id IS NOT NULL;
```

The two `kind` values that are not `user` carry rules the constraint cannot state, so they are
**refused in words** (`deck::set_folder`'s rule — a constraint failure names the table and not
the mistake, and `PRAGMA foreign_keys` is per-connection anyway):

- A `deck` or `removed` folder is always `parent_id IS NULL` and cannot be reparented. This is
  what makes the Decks section flat and locked.
- Neither can be renamed or deleted by hand. A deck group's name follows its deck's name.
- Nothing can be moved *into* a `deck` or `removed` folder by the ordinary folder-move
  command; copies get there only through the two writes in §5.

### 3.2 The eleventh grain term

```rust
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, \
     proxy, misprint, coalesce(serial_number, ''), coalesce(grading, ''), \
     coalesce(folder_id, 0)";
```

This is v23's fourth-term reasoning applied one table over, and it is the load-bearing decision
of the whole design. **Without it, filing a card into a deck group would land on the row the
reader already had and raise its quantity** — the binder copy would appear to *move* rather
than one copy being allocated, and a playset would collapse into whichever folder was pointed
at last.

`coalesce(folder_id, 0)` can never collide with a real folder: `collection_folders.id` is
`INTEGER PRIMARY KEY` and SQLite never auto-assigns rowid 0. It is a `coalesce` for the reason
the grain's other two are — NULL is the root, the root is where most cards live, and **NULLs in
a UNIQUE index are distinct**, so an un-coalesced term would stop enforcing anything for
exactly the rows that need it most.

Two traps, both recorded by the v23 step and both live again here:

1. **`idx_collection_grain` is DROPped and re-CREATEd, never added to.** SQLite has no
   `ALTER INDEX`, and the `DROP` has to come first or the `CREATE` is a silent no-op on exactly
   the machines that already carry the ten-column index.
2. **`ADD COLUMN` has no `IF NOT EXISTS`.** The step probes
   `pragma_table_info('collection_entries')` first, because a rewind fixture cannot drop
   `folder_id` — SQLite refuses `DROP COLUMN` on a column an index names, and this one is the
   grain's eleventh term.

The DDL is **spelled out literally and never interpolated from `COLLECTION_GRAIN`**, the rule
the v4, v8 and v23 steps all state: a migration step is history, and a step that read the
constant would silently rewrite what a *fresh* install creates the next time the grain moves.

### 3.3 The rest of the rung

3. Insert the single `Recently removed` folder (`kind='removed'`, `parent_id NULL`).
4. Insert one `kind='deck'` folder per existing row in `decks`, named after the deck.
5. **Convert every `deck_allocations` row into a placement** — see §6.
6. `DELETE FROM collection_entries WHERE quantity = 0` (§8.3's new rule).
7. `DROP TABLE deck_allocations`.
8. `ALTER TABLE decks DROP COLUMN is_built` — available because no index names it (verified
   2026-08-23 against `schema.rs`).
9. `DELETE FROM app_meta WHERE key = 'deck_driven_collection'`.

`schema.rs`'s module-doc inventory of every `ON DELETE` action and every grain gains
`collection_folders` and loses `deck_allocations` **in the same commit** — that inventory is
what catches a rung adding one half of a filing cabinet, since a prose-only edit routes to
neither CI job.

## 4. Deck-driven's removal

Deleted outright:

| Path | Note |
| --- | --- |
| `src-tauri/src/deck_driven.rs` | The flag, `stored()`, `switch()` |
| `src-tauri/src/collection_decks.rs` | `row_decks` — the folder answers this now (§7) |

**`collection_source.rs` is gutted, not deleted, and the distinction matters.** Two different
things live in that file and only one of them is deck-driven's. Out come `rows()` (the derived
subquery and its two shapes), the `LIVE` constant, `with_write_owned_if_derived`, and the
derived branch inside `with_write_owned`. **What stays** is the part every build needs: the
`with_write_owned` wrapper that keeps the search index's `owned` dimension in step with a
collection write, and the owned-lookup helpers `owns_printing`, `copies_of_printing`,
`copies_of_oracle` and `owned_rowids`, which `index/mod.rs`, `wishlist.rs` and `deck_theory.rs`
all read. The file keeps its name: renaming it would be a case-collision risk on Windows and a
merge hazard across four stacked PRs, for no gain.
| `src/lib/useDeckDrivenCollection.ts` | + its test |
| `src/features/settings/DeckDrivenPanel.*` | Component, test, stories; and its row in `SettingsPage.tsx` |

Removed in place: the five write refusals in `collection.rs`; `with_write_owned`'s derived arm;
the `deckDriven` fences in `ImportDialog.tsx`, `CollectionPreview.tsx` and `useImport.ts`; the
greyed `Add to → Collection` row and `DECK_DRIVEN_REASON` in `cardMenu.tsx`; the derived arms of
`deck_theory::owned_spare_sql` and `deck::attribute_owned`; the early return in `allocate_deck`
(which is deleted wholesale anyway); the `deckDriven` field on `CardMenuDeps`; and every
`deckDriven` seed and fault in `.storybook/fake/`.

**Per the decision in §11, the upgrade is silent.** The flag disappears and the reader's
hand-built `collection_entries` — which deck-driven never touched — simply come back. No
banner, no one-time copy.

`docs/reference/deck-driven-collection.md` is **replaced** by a new
`docs/reference/collection-folders.md` rather than left to rot, and every table row pointing at
it in `CLAUDE.md` and the area `CLAUDE.md`s moves with it.

## 5. The two writes

Everything in the feature reduces to a pair of commands. Both are one transaction, for the
reason every fold in this crate is one: mid-move the copies are in both places or in neither.

### 5.1 `collection_to_deck(entry_id, deck_id, category_id, quantity)`

Moves copies out of their folder into the deck's group **and** writes the `deck_cards` row.

- Splits the source row: reduce it by `quantity`, and **delete it if that reaches zero** (§8.3).
- Lands the copies on the destination grain in the deck's group, merging if that grain is
  already taken (§8.1).
- If the source folder is **another deck's group**, that deck's live list is decremented by the
  same quantity. This is the case the UI confirms before pressing (§7.2).
- Refuses in words if the deck is gone, the entry is gone, or `quantity` exceeds what the
  source row holds.

### 5.2 `deck_to_collection(deck_card_id, quantity)`

The inverse, and the whole of issue #209.

- Whatever copies **the deck's own group** holds for that printing move to `Recently removed`,
  merging on a taken grain.
- The `deck_cards` row is decremented or deleted.
- **A deck card with no backing copies in the group just goes away.** The reader never owned it,
  so nothing lands on their desk. This is what makes the deck group itself the provenance
  record — no per-deck-card flag is needed, which is the question #209 asked and could not
  answer.
- `theory` variants never reach this command at all. A theory list is a plan, and a plan holds
  no cards.

### 5.3 Deck lifecycle

- **Create** a deck → create its group, named after the deck. `deck_meta::ensure_predefined_categories`
  is the precedent for "every deck gets this, from here on".
- **Rename** a deck → rename its group.
- **Delete** a deck → refile its group's cards to `Recently removed` **by hand, one at a time,
  before** the cascade takes the folder. One at a time is not a style choice: it is what makes
  two of the deck's rows that collide *with each other* at the destination merge instead of
  raising `UNIQUE constraint failed`, exactly as `wishlist_folders::delete_folder` does it.
  Per the decision in §11 this is unconditional — no question in the confirmation.
- **Archive** a deck → nothing. An archived deck still holds its cards.

## 6. Migration of existing allocations

Step 5 of the rung, written out because it is the step that decides whether the release feels
like a regression.

For each `deck_allocations` row `(deck_id, collection_entry_id, quantity)`, ascending by id:

1. Read the source `collection_entries` row in full.
2. Reduce its `quantity` by the claim, clamped at 0 — the ledger could out-claim a row that was
   later stepped down, which `owned_by_oracle`'s `min(a.quantity, e.quantity)` was papering
   over.
3. Insert a row into that deck's group carrying **every grain column and every provenance
   column** of the source (condition, `condition_original`, purchase price and currency,
   acquired-at, source, notes, tags, tradelist), holding the claimed quantity — merging if that
   grain is already taken.
4. Delete the source row if it reached 0.

A database with no allocations (a fresh install, or one that had deck-driven on) is unaffected:
every deck gets an empty group and every card stays where it was.

**`reconcile::fold_into_existing` loses its three allocation statements** (`reconcile.rs:470-491`)
and keeps only the entry fold. That code existed solely because `deck_allocations` held the only
enforced FK into `collection_entries`; `collection_folders` holds no FK *into* entries, so
nothing needs repointing.

**`reset::clear_collection` loses `CollectionCleared.allocations`** — a public DTO field the
settings panel renders — and gains the folder wipe: entries first, **then** folders, needed
explicitly rather than by cascade because `folder_id` is SET NULL (the wipe that stopped at
entries would hand the reader an empty filing cabinet to take apart one drawer at a time). The
count reported stays the count of *cards*. Deck groups and `Recently removed` are re-created
empty rather than left missing.

## 7. The five UI surfaces

### 7.1 Collection page

Ported from the wishlist, which already shipped every piece:

- **Folder cards** in the grid and a **breadcrumb**, with drag-to-file. The breadcrumb segments
  are drop targets too — without them a drag could only ever push cards deeper.
- **`src/lib/folderTree.ts` is reused unchanged.** It is already fully generic: a collection
  folder answers `FolderLike` (`id, parentId, name, sortOrder`) and a collection row answers
  `Filed` (`folderId`). Note `src/features/decks/folders.ts:17-30`'s warning — a
  case-insensitive filesystem makes a second `folderTree.ts` next to a `FolderTree.tsx` unsafe,
  so nothing new is named that.
- **A pinned Decks section and a pinned `Recently removed`** sit beside the reader's own
  nestable tree, not inside it.
- `DeckCountCell` is replaced by the row's **folder** — one name, not a hover query. This is a
  net deletion of a lazy per-row ipc call.
- A collection drag payload under **its own key** (`collectionSource`), never `dnd.ts`'s
  `dragSource` — `wishDrag.ts`'s decision, for its reason: sharing the key would force this
  module's mark onto the card payload and one of the two readers would be lied to.

### 7.2 Deck search panel

Two tabs in the header row that `DeckSearchPanel.tsx:496-506` documents as having free space
since the "Add to" select was removed. `aria-pressed` over a `.map`, the shape `DeckEditor.tsx:2879`
already uses for Theory/Live — **not** `role="tab"`. Wraps at the 206 px `MIN_PANEL_WIDTH_PX`.

- **Collection Search is the default tab.** It reads `collection_list` with the card filters the
  panel already builds, plus the two new query fields in §8.4. Results are collection *rows* —
  printing, finish, condition, and where the copy is filed.
  - A **show all cards ↔ only unallocated** toggle. "Unallocated" means root, a user folder, or
    `Recently removed` — cards on the reader's desk. Default: only unallocated.
  - Adding calls `collection_to_deck`. If the copy sits in another deck's group, a confirm names
    that deck first: *"This copy is in Mono-Red Aggro. Move it to this deck?"* The confirm exists
    because the side effect lands on a deck the reader is not looking at. (Note for whoever
    tests it: this app's confirmations carry **no** `dialog` or `alertdialog` role — find it by
    its text.)
- **Normal Search** is today's panel, plus a sticky two-state toggle: **Adding: cards I own ↔
  cards I need**, remembered per deck.
  - *cards I need* → today's behaviour exactly: a `deck_cards` row, no collection row, reads as
    missing.
  - *cards I own* → **prefers to move a free copy the reader already has** into the deck's group,
    and only creates a new collection row in the group if no free copy exists. That makes the
    two tabs agree: "I own this" does the same thing whether the reader found the card by
    searching Scryfall or by searching their binder.

    **Which free copy, when there are several**, is `allocate_deck`'s old preference order kept
    verbatim — the exact printing first, then another printing of the same **oracle** card, real
    copies before proxies, then entry id ascending. That order was the one piece of the
    allocator worth keeping, and preserving it is why a reader who used to let the allocator
    choose sees the same copy chosen now. Copies in another deck's group are never candidates
    here: this path is silent, and taking another deck's card is only ever done through the
    confirm above.
  - The panel calls `useCardSearch` from a child component for the reason `OpenPanel` exists —
    so the hook is called conditionally. The Collection tab's data hook lives in its own sibling
    for the same reason.

### 7.3 Card menu

- **`buildCollectionTargetItems`**, mirroring `buildWishlistTargetItems` (`cardMenu.tsx:809-826`)
  including both of its rules: root first and never omitted; **a leaf folder is a plain action,
  a folder with children is a submenu whose first item is itself**; empty folders are kept.
  Deck groups and `Recently removed` are **not** offered as targets — copies get there only
  through §5.
- The existing finish branch is preserved: the folder submenu composes under it, so a card with
  two finishes picks finish then folder.
- **`Move to → folder`** for collection rows, calling `collection_set_folder`. It follows
  `EditWish.tsx`'s precedent — the shared `MoveToFolder.tsx` picker is a list of buttons, not
  `MenuItem[]`, so a context-menu version builds items the way `buildCollectionTargetItems`
  does and the popover version reuses the picker.
- `CardMenuDeps` gains `collectionFolders`, filled once per page mount by a list-only hook —
  the wishlist's shape, which is why its submenu is eager and the deck picker is `lazy`.

### 7.4 Import

- An **"Add cards to collection"** checkbox on `DeckPreview` (and `NewDeckPreview`), beside the
  existing `<Mode>` control. It lives in the preview's own state, never on `DeckImportInto` —
  that interface is identity-only, and `deckDestination` is memoised on what it closes over, so
  a presentational field there would remount the step under the reader.
- Ticked, the commit writes collection rows **into that deck's group**, so the decklist and the
  group agree immediately and the cards are correctly unavailable to other decks.
- Two commands, one press: `useImport.ts`'s `importIntoNewDeck` (`:175-196`) is the precedent,
  hand-rolled rollback included. Invalidation is the **union** of the deck write roots and the
  collection path's own set.
- The collection items are produced by calling `planCollectionImport` a second time over the
  same `resolved` rows — it is already pure — rather than adapting deck items across, because
  the grains differ.

### 7.5 Settings

`DeckDrivenPanel` and its row come out. Nothing replaces them.

## 8. Duplicates and quantity

Four changes, three of them fixes to defects that exist today and one of them new.

### 8.1 A write that lands on a taken grain merges (new)

`collection.rs` gains **`refile_entry`**, the exact shape of `wishlist_folders::refile_wish`:

1. Read the source row's grain columns and quantity in one statement — which also answers "is
   it still there?", because an `UPDATE` changing 0 rows cannot tell a missing row from a
   collision.
2. Probe the grain it is about to land on, **spelled out in SQL rather than interpolated from
   `COLLECTION_GRAIN`**, all eleven terms, `id <> source`.
3. Hit → sum the quantities into the destination, take the destination's notes falling back to
   the source's (`add_entry`'s own `ON CONFLICT` direction — the destination is the row the
   reader filed and annotated), delete the source, and answer an `EntryChange` whose `id` is the
   **destination's**, not the id the caller handed in.
4. Miss → a plain `UPDATE … SET folder_id = ?`, with NULL bound as a *value* rather than
   `coalesce(?, column)`, so "back to the root" is expressible.

`update_entry` stops refusing with *"You already have an entry for that printing at that finish
and condition"* (`friendly()`, `collection.rs:681-689`) and merges instead. **This is the fix
that must land**: with a folder in the grain, every move into an occupied folder hits that
refusal.

### 8.2 The importer's fold widens to the full grain

`destinations/collection.ts:94` folds importer items on `(cardId, finish, condition)` while the
real grain is eleven columns, and `commit_import` hard-codes altered/signed/proxy/misprint/
serial/grading to defaults (`collection.rs:508-513`) — so a re-import can never land on the
reader's altered or graded row and writes **a second all-defaults entry beside it**.
`import-export.md:225-262` writes this up as "latent, not live". §7.4's toggle is exactly what
makes it live, so it is fixed here: the fold key becomes the full grain, and the commit carries
the six columns rather than defaulting them.

### 8.3 Zero quantity deletes the row

Per the decision in §11: a row taken to zero is removed, because the reader no longer owns any
copies. `set_quantity(id, 0)` deletes and answers `EntryChange { removed: true }`; the rung
deletes existing zero rows; `commit_import`'s `set` mode does the same.

**The cost is real and is accepted deliberately.** The row's condition, `condition_original`,
purchase price, acquired-at, acquisition source, notes and tags go with it — which is precisely
what the current behaviour was preserving. `a_row_emptied_to_zero_still_lists_and_is_still_a_printing_the_collection_knows`
(`collection.rs:2434`) and the three "tidy-ups" its doc warns against are **replaced** by a test
asserting the new rule, not deleted quietly.

Everything downstream simplifies with it: `summarise`'s split between `total_cards` (sums
quantity) and `unique_cards`/`entries` (count rows) stops being able to disagree; the search
facet's `owned` dimension and `collection_source::owns_printing`'s `EXISTS` stop reading a zero
row as owned. The `CHECK (quantity >= 0)` stays on the column — the guard is the command, and
an intermediate zero inside a transaction is still legal.

### 8.4 `CollectionQuery` gains two fields

```rust
pub folder_id: Option<i64>,          // None = every folder; the tree filters by this
pub allocation: Option<Allocation>,  // All | Unallocated
```

`Unallocated` is `folder_id IS NULL OR folder.kind <> 'deck'`. Both default to today's
behaviour (everything), so every existing caller is unchanged.

## 9. Rust module inventory

| Module | Change |
| --- | --- |
| `collection_folders.rs` | **New.** The seven commands modelled on `wishlist_folders.rs` — list, create, rename, move, delete, `collection_set_folder`, `folder_summary` — plus `ensure_deck_folder`, `removed_folder_id`, `refile_entry`, and the three refusals of §3.1 |
| | `folder_summary(marketplace)` answers `{ folderId, cards, value }` per folder — copies and worth at the named marketplace, both the page header's own arithmetic rather than a second spelling of it. Two shape rules are inherited whole from the wishlist's: the counts are **direct**, never recursive, because `buildFolderTree` already sums the children on the TS side and two implementations of one figure disagree the first time either changes; and **an empty folder produces no row at all**, so a page cannot build its tree from this command — `collection_folder_list` is the census and the summary is a lookup layered onto it |
| `collection_alloc.rs` | **New.** `collection_to_deck` and `deck_to_collection` (§5) |
| `collection.rs` | Grain, `refile_entry` wiring, zero-deletes, `folder_id` on add/list/filter, the five refusals removed |
| `deck.rs` | `allocate_deck`, `allocate_every_deck` and the run list deleted; `owned_by_oracle` reads the deck's group; `attribute_owned` loses its derived arm; `is_built` removed; create/rename/delete wired to §5.3 |
| `deck_theory.rs` | `OWNED_SPARE_SQL_TABLE` rewritten off allocations |
| `reconcile.rs`, `reset.rs`, `import.rs`, `search.rs`, `index/mod.rs` | As §6 and §8 describe |
| `schema.rs` | The v24 step, the grain, both inventories |
| `collection_source.rs` | **Gutted, not deleted** — see §4. Keeps `with_write_owned` and the four owned-lookup helpers |
| `deck_driven.rs`, `collection_decks.rs` | **Deleted** |

## 10. Testing

- **Rust**, in the inline `#[cfg(test)]` modules: every new grain term exercised one at a time
  (`schema.rs:3336`'s rule); the v24 rung driven forwards from a v23 fixture *and* over a
  database that already has allocations, asserting the split arithmetic; both §5 writes
  including the cross-deck move and the unbacked-deck-card case; the merge rule on every path
  that can hit a taken grain; the three refusals of §3.1 in words; zero-deletes.
- **TypeScript**: the folder tree over collection rows; the two tabs' state; the sticky own/need
  toggle; `buildCollectionTargetItems` (the leaf-vs-parent rule and the root-first rule); the
  import toggle's two-command commit and its rollback.
- **Storybook**: the fake gains collection folders, deck groups and `Recently removed`, and
  loses every `deckDriven` seed and fault. Expect a fix round — a corpus row has broken 25 plays
  across five unrelated files before.
- **The live window**, over CDP, per `live-ui-verification.md`: the drag-to-file path (the
  wishlist's equivalent shipped with a bug where a filed row vanished until reload, because a
  plain move invalidated nothing), the two tabs at 206 px, and the cross-deck confirm.
- `npm run verify` is run **once by me after each fan-in**, never inside a subagent — a slice
  compiles against a tree its siblings are still changing. `cargo fmt` and `clippy` are run
  separately: `verify` does not cover them and they are the only reds a fully green verify can
  still produce.

## 11. Decisions, and what was rejected

| Decision | Rejected alternative |
| --- | --- |
| Folders **replace** the allocator | Folders as a view over `deck_allocations`; keeping both (two sources of truth about one physical card) |
| A Normal Search add asks **own vs need** via a sticky per-deck toggle | A split button on every tile (two controls at 206 px); a dialog per add |
| One global `Recently removed`, **backed copies only** | Every removal (#209: "silently accumulates a pile you never asked for"); one per deck |
| Deck groups in a **separate, flat, locked** section | Ordinary nestable folders marked deck-owned; fully ordinary folders |
| Deck delete → **always** to `Recently removed` | Asking in the confirmation; straight to the root |
| Import files into **that deck's group** | The root, unfiled; a folder picker |
| `is_built` **retired entirely** | Kept as a label; repurposed as "its group is filled" |
| Deck-driven upgrade is **silent** | A one-time "copy my live decks in" offer; auto-copying |
| Taking another deck's copy is **allowed, with a confirm naming the deck** | Blocked; allowed silently |
| Zero quantity **deletes the row** | Keeping the row and its provenance (today's documented behaviour) |

## 12. Shipping

One branch, four stacked PRs in dependency order, each green on `npm run verify`, each armed
with `auto-pr`:

1. **Remove deck-driven collection** — §4, plus the fake's seeds and faults.
2. **Collection folders** — §3, §7.1, §8. **Closes #215.**
3. **Deck groups, exclusivity, `Recently removed`** — §5, §6, the allocator's removal, `is_built`'s
   retirement. **Closes #209.**
4. **Deck builder, card menu, import** — §7.2, §7.3, §7.4.

Implementation is subagent-driven, fanned out along this repo's existing seams (Rust command /
TS domain logic / UI / stories / docs). Two subagents never share a file. A new
`docs/reference/collection-folders.md` replaces `deck-driven-collection.md` and carries the
record of what shipped, with every measured figure naming its build.
