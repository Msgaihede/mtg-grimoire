# Locked collection folders — implementation plan

Design: [2026-09-03-locked-collection-folders-design.md](../specs/2026-09-03-locked-collection-folders-design.md).
Issue [#365](https://github.com/Msgaihede/mtg-grimoire/issues/365). Read the spec first — this
page is the split, not the reasons.

**Nine buckets, no file in two of them.** Two subagents editing one file in one tree clobber each
other, so the table below is the ownership record and a file that is not on it is nobody's.

| Bucket | Owns |
| --- | --- |
| **A · Schema** | `src-tauri/src/schema.rs` |
| **B · Folder layer** | `src-tauri/src/collection_folders.rs` |
| **C · Query and availability** | `src-tauri/src/collection.rs`, `src-tauri/src/deck_theory.rs` |
| **D · Registration and sync** | `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs`, `src-tauri/src/sync_engine/capture.rs`, `src-tauri/src/mirror/layout.rs` |
| **E · ipc, hooks, tree** | `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/folderTree.ts`, `src/lib/folderTree.test.ts`, `src/features/collection/useCollectionFolders.ts`, `…/useCollectionFolders.test.ts`, `src/lib/dndAccessibility.test.tsx`, `src/features/card/cardMenu.test.tsx` |
| **F · Collection UI** | `src/features/collection/CollectionFolderCard.{tsx,test.tsx,stories.tsx}`, `…/CollectionPage.{tsx,test.tsx,stories.tsx}`, `…/PinnedFolders.tsx` |
| **G · Deck search tab** | `src/features/decks/useCollectionSearch.{ts,test.ts}`, `…/CollectionSearchTab.test.tsx` |
| **H · Storybook fake** | `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts` |
| **I · Docs** | `docs/reference/collection-folders.md` |

## Order

**A lands before D**, and that is the only hard sequence: `capture.rs`'s
`every_column_a_spec_names_exists_on_its_table` runs `pragma_table_info` over a real migrated
database, so a spec naming `locked` before the rung creates it is red. Everything else is
independent by file.

**Tests run once, at fan-in.** A bucket's slice compiles against a tree its siblings are still
changing, so a suite run mid-fan-out fails for reasons that are not its own. Each bucket reports
what it changed; `npm run verify` runs afterwards, once, from the session that dispatched.

## The contract every bucket codes against

Agreed here so nine agents cannot each invent it:

- Rust: `CollectionFolder.locked: bool`, read from column index **6** (`SELECT id, parent_id,
  name, kind, deck_id, sort_order, locked`), stored `INTEGER NOT NULL DEFAULT 0`, non-zero is
  locked.
- Command **`collection_folder_set_locked`**, args `{ id: i64, locked: bool }`, answers the
  re-read `CollectionFolder`.
- TS: `CollectionFolder.locked: boolean` (required, not optional), wrapper
  **`collectionFolderSetLocked(id, locked)`**.
- `CollectionQuery` gains **`exclude_locked: bool`** / **`excludeLocked?: boolean`**, default
  `false`, ignored when `folder_id` names a folder.
- Refusal constant **`collection_folders::FOLDER_IS_LOCKED`** = `"That folder is locked. Unlock it
  before deleting it."`
- The locked-descendants CTE, spelled once in Rust and once in TS, both named in the spec §3.

## Bucket detail

### A · Schema
Rung **v33** at the bottom of `migrate_user`, below v32 and above the unconditional `sync_clock`
repair. `ALTER TABLE collection_folders ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;` then
`PRAGMA main.user_version = 33;` with a literal 33. Bump `USER_SCHEMA_VERSION` and extend its doc
paragraph. Update `USER_SCHEMA_SQL`'s `collection_folders` DDL **by copying `sqlite_master` back
out of a migrated database**, never by retyping — `the_user_schema_is_byte_identical_to_what_the_ladder_builds`
compares string-for-string. Add `UNDO_V33`, prepend it to `user_file_at_31`, `user_file_at_28`,
`user_file_at_27` and the inline chain in the `split::convert` test. Tests
`v33_adds_the_locked_column` and `the_v32_fixture_carries_none_of_v33`. **Do not touch the v24
rung's DDL** — a migration step is history. The index count 62 does not move; there is no new index.

### B · Folder layer
Struct field, `folder_row` index 6, both SELECTs. `set_folder_locked` in `rename_folder`'s exact
shape (`user_folder` fence first, `updated_at = unixepoch()`, re-read). `FOLDER_IS_LOCKED`.
`delete_folder` refuses on the **effective** lock. A `pub(crate)` helper answering "is this folder
effectively locked" and one exposing the CTE fragment for C. Tests per spec §8.

### C · Query and availability
`CollectionQuery.exclude_locked` with a doc paragraph in `root_only`'s voice — the mirror and the
export are the callers whose silence must keep meaning "everything". The `scope` term, correlated,
`IS NULL` first, guarded by `folder_id.is_none()`. `OWNED_SPARE_SQL` gains the locked arm beside
its deck arm. Tests per spec §8, including
`a_query_that_never_asks_still_sees_a_locked_folders_copies`.

### D · Registration and sync
Register the command in `desktop.rs`'s `generate_handler!` **and** `web/route.rs`'s `COMMANDS`
plus its match arm. Add `"locked"` to the `collection_folders` capture `Spec`'s `fields` — that is
the whole sync change; `apply.rs`'s `META` is not edited. Repair `mirror/layout.rs`'s
`fn user_folder` test builder, which is a hard compile error until it carries the field.

### E · ipc, hooks, tree
The interface field and the wrapper. Add `CollectionFolder` to `ipc.test.ts`'s **`plainMirrors`**
(the struct is on neither list today; this needs the `collection_folders.rs?raw` import too) and
the eighth wrapper to the command-name pin. `folderTree.ts` gains the effective-lock ancestry
walk. `useCollectionFolders` gains a `setLocked` mutation on the shared `writes` invalidation.
Repair the `CollectionFolder` literals in the two test files listed above.

### F · Collection UI
The `Lock` glyph swap and the `folderFace` clause. The menu's Lock/Unlock row, greyed with its
reason when an ancestor is locked; Delete greyed with its reason when effectively locked. The
drag confirmation, both directions, named. Send `excludeLocked` from the page. Rename
`PinnedFolders.tsx`'s doc word *locked* → *fixed* and add the sentence distinguishing the two.

### G · Deck search tab
Send `excludeLocked: true` — the tab answers "what can I build with today", which is exactly the
question a set-aside drawer is not part of. Repair its two fixture files.

### H · Storybook fake
`FakeCollectionFolder.locked`, `toCollectionFolder`, the seeds (lock one starter folder so a story
can show the badge), a `collection_folder_set_locked` write handler behind `refuseIfBusy`, and the
`FOLDER_IS_LOCKED` refusal on delete. The fake's busy sweep counts write handlers — re-count it.

### I · Docs
`collection-folders.md` gains a section for the lock: the column, the inheritance, the four lists
of §4, and the ghost the issue named. **Do not write down a count a build already answers.**
