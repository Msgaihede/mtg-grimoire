# Titled To-do Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Several titled to-do lists per deck, drawn as note-style cards that tick in place, each
edited in a dialog whose editor holds headings and paragraphs beside any number of task lists.

**Architecture:** A new synced table `deck_todo_lists` (user schema v59) replaces the single
`decks.todos` column, converted in the rung with derived uids. Rust stores and compare-and-sets
bodies; `todoMarkdown.ts` reads a body into blocks; `NoteEditor`'s checklist mode widens to a
to-do document; the band draws cards and a dialog owns the autosave; the widget groups deck →
list → to-dos.

**Tech Stack:** Rust (rusqlite, Tauri 2 commands), React 19 + TypeScript 6, Tiptap 3
(`@tiptap/extension-list` 3.31.3), TanStack Query, Vitest, Storybook fake db.

**Spec:** `docs/superpowers/specs/2026-09-29-titled-todo-lists-design.md` (amends
`2026-09-29-deck-todos-design.md`). Read both before any task.

## Global Constraints

- User schema **v59**; `USER_SCHEMA_VERSION` is 58 today. Head literals move 58 → 59.
- Table `deck_todo_lists`; indexes `idx_deck_todo_lists_deck (deck_id, sort_order)` and
  `idx_deck_todo_lists_uid (sync_uid)` UNIQUE.
- Converted list title: `To-do`. Untitled list display: `Untitled list`.
- Derived uid: lowercase hex of first 16 bytes of SHA-256 over `deck_todo_lists/legacy/<deck uid>`.
- Refusal sentences (Rust `pub const`, TS reads them verbatim):
  `TODOS_CHANGED = "That to-do list changed since it was read. Try again."`,
  `TODO_LIST_GONE = "That to-do list is not there any more."`,
  `TODO_LIST_WRONG_DECK = "That to-do list belongs to a different deck."`
- `NoteEditor` is reached **only** through `React.lazy` — a static or type import anywhere fails
  `DeckNotesPanel.test.tsx`'s sweep.
- **No `setState` in an effect body** (`react-hooks/set-state-in-effect`, only `verify` catches it).
- Subagents **do not run `npm run verify`** or the whole suite; run only your own test files.
  Only the Rust task runs `cargo`. The coordinator runs `npm run verify` after fan-in.
- Never commit; the coordinator commits after fan-in.

## Review Focus

1. **A body written by the #672 build** (every line a to-do, no text) must read and edit exactly as
   before — the corpus keeps every #672 entry, and the reader test asserts #672's trees unchanged.
2. **A paragraph line that starts `- [ ]` typed as text** — the editor escapes it on write
   (`\- [ ]`) and the reader must read the escaped line as text, not a to-do. Pinned in Task 3 and
   Task 2.
3. **Ticking a card while its dialog is open in another window** — the tick's compare-and-set
   refuses with `TODOS_CHANGED` and the band refetches rather than overwriting. Pinned in Task 5.
4. **Closing a New to-do list dialog after typing only a title** — that is not blank; it creates a
   list with an empty body. Pinned in Task 5.
5. **A converted deck whose `sync_uid` is NULL** — the rung writes a row with a NULL uid and does
   not fail. Pinned in Task 1.

---

## Contracts every task shares

### Rust → IPC (Task 1 produces, Task 4 mirrors)

```rust
#[serde(rename_all = "camelCase")]
pub struct DeckTodoList { pub id: i64, pub deck_id: i64, pub title: String, pub body: String,
  pub sort_order: i64, pub created_at: i64, pub updated_at: i64 }

#[serde(rename_all = "camelCase")]
pub struct DeckTodoListEntry { pub id: i64, pub deck_id: i64, pub deck_name: String,
  pub archived: bool, pub todos_open: bool, pub title: String, pub body: String,
  pub updated_at: i64 }
```

| Command (`generate_handler!` name) | Invoke args (camelCase) | Returns |
| --- | --- | --- |
| `deck_todo_lists` | `{ deckId }` | `DeckTodoList[]` |
| `deck_todo_list_create` | `{ deckId, title, body }` | `DeckTodoList` |
| `deck_todo_list_update` | `{ deckId, id, title: string\|null, body: string\|null, expected: string\|null }` | `null` |
| `deck_todo_list_delete` | `{ deckId, id }` | `null` |
| `every_deck_todo_list` | `{}` | `DeckTodoListEntry[]` |

Removed: `deck_todos`, `deck_todos_set`, the old `deck_todo_lists()` and the old
`DeckTodoList` widget struct.

### TS (Task 4 produces)

```ts
// src/lib/ipc.ts
export interface DeckTodoList { id: number; deckId: number; title: string; body: string;
  sortOrder: number; createdAt: number; updatedAt: number }
export interface DeckTodoListEntry { id: number; deckId: number; deckName: string;
  archived: boolean; todosOpen: boolean; title: string; body: string; updatedAt: number }
ipc.deckTodoLists(deckId: number): Promise<DeckTodoList[]>
ipc.deckTodoListCreate(deckId: number, title: string, body: string): Promise<DeckTodoList>
ipc.deckTodoListUpdate(deckId: number, id: number,
  change: { title?: string | null; body?: string | null; expected?: string | null }): Promise<void>
ipc.deckTodoListDelete(deckId: number, id: number): Promise<void>
ipc.everyDeckTodoList(): Promise<DeckTodoListEntry[]>

// src/features/home/keys.ts — value unchanged
export const deckTodoListsKey = ["decks", "todos", "lists"] as const;
// src/features/decks/useDeckTodos.ts — key unchanged
export const deckTodosKey = (deckId: number) => ["decks", "todos", deckId] as const;
export function useDeckTodoLists(deckId: number): {
  lists: DeckTodoList[] | undefined;      // undefined until the first read lands
  failure: string | null;                 // ipcError of the read, or null
  tick: UseMutationResult<void, unknown, { id: number; body: string; expected: string }>;
  remove: UseMutationResult<void, unknown, number>;  // id
};
// Saves with the TanStack scope `todo-list-dialog-${instance}`; see Task 5.
export function useTodoListSave(deckId: number, scopeId: string): UseMutationResult<
  DeckTodoList | void, unknown,
  { id: number | null; title: string; body: string; idRef: { current: number | null } }>;
```

`useTodoListSave`'s `mutationFn` reads `idRef.current` **when it runs** (not when queued): if it
is `null` it creates and writes the answered id into `idRef.current`; otherwise it updates
`{ title, body, expected: null }`. `onSuccess` cancels in-flight reads of `deckTodosKey(deckId)`,
then writes the list into that cache (replace by id, or append), and invalidates
`deckTodoListsKey`. `tick` sends `{ body, expected }` and on success writes the body into the
cache; on error it invalidates `deckTodosKey(deckId)`. `remove` deletes and removes the row from
the cache, invalidating `deckTodoListsKey`.

### Reader (Task 2 produces)

```ts
// src/features/decks/todoMarkdown.ts
export type TodoBlock =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[]; text: string; line: number }
  | { kind: "text"; inlines: Inline[]; text: string; line: number }
  | { kind: "todos"; items: TodoItem[] };
export function parseTodoBody(body: string): TodoBlock[];
export function parseTodos(body: string): TodoItem[];      // every "todos" block's items, concatenated
export function isBlankList(title: string, body: string): boolean;
export const UNTITLED_LIST = "Untitled list";
export function listTitle(title: string): string;          // trimmed title, or UNTITLED_LIST
// unchanged: TodoItem, countTodos, toggleTodo, visibleTodos, sameTodos
// removed: todosText
```

### Editor (Task 3 produces)

`NoteEditor` props unchanged (`mode?: "note" | "checklist"`, `appendRequest`, `onAppendHandled`).
`TODO_PLACEHOLDER` becomes `"Write, or add a to-do — Enter for the next, Tab to nest."`.
Toolbar button accessible names: `Heading 1`, `Heading 2`, `Heading 3`, `Paragraph`, `To-do`
(each a toggle with `aria-pressed`), plus the existing mark buttons, `Outdent`, `Indent`.

---

### Task 1: Rust — v59, the census, and `deck_todos.rs`

**Files:**
- Modify: `src-tauri/src/schema.rs` (rung after v58, `USER_SCHEMA_SQL`, `TABLES`, `SYNCED_TABLES`,
  `todo_list_uid` beside `theory_pile_uid`, `UNDO_V59` + all 27 chains, head literals, byte-identity
  count 85 → 87, docs of the old head)
- Modify: `src-tauri/src/sync_engine/capture.rs` (new `Spec`, `todos` off `decks`, the
  `a_decks_todo_list_and_its_disclosure_are_captured` test), `src-tauri/src/sync_engine/apply.rs`
  (new `Meta`, next free `order`, prose counts), `src-tauri/src/mirror/watch.rs` (`DECKS_ONLY` arm
  and both fences), `src-tauri/src/deck_todos.rs` (rewrite), `src-tauri/src/desktop.rs`
  (`generate_handler!`), `src-tauri/src/deck.rs` (`duplicate_deck` doc only if it names `todos`),
  `src-tauri/src/deck_undo.rs` (doc only), `src/lib/userTables.json`, `src/lib/syncedTables.json`,
  `docs/reference/sync.md` and `src-tauri/CLAUDE.md` ("Seventeen" → "Eighteen" where it counts
  synced tables)

**Interfaces:** Produces the Rust contract above.

- [ ] **Step 1: Failing tests in `deck_todos.rs`' test module** — create returns a row with
  `sort_order` = previous max + 1 and bumps the deck's `updated_at`; `lists_for` answers in
  `sort_order, id` and `[]` for an unknown deck; update with `expected` mismatching refuses
  `TODOS_CHANGED` and writes nothing; update of a missing id refuses `TODO_LIST_GONE`; update
  through the wrong deck refuses `TODO_LIST_WRONG_DECK`; an update equal to what is stored leaves
  both `updated_at`s alone; delete is idempotent; deleting a deck cascades; `every_list` leaves
  out empty bodies, carries the deck's name/archived/todos_open, orders `updated_at DESC, id`;
  nothing writes `sync_uid` (copy `deck_notes.rs`' `nothing_here_writes_the_sync_uid_column`).
- [ ] **Step 2: Failing schema tests** — a v58 database with deck A (`todos = '- [ ] a'`,
  `sync_uid = 'abc'`), deck B (`todos = ''`) and deck C (`todos = '- [ ] c'`, `sync_uid NULL`)
  climbs to v59 with: one row for A titled `To-do`, body `- [ ] a`, `sync_uid =
  todo_list_uid("abc")`; none for B; one for C with `sync_uid IS NULL`; `decks` has no `todos`
  column; `todos_open` kept. Plus the rewind lands back on v58's exact shape.
- [ ] **Step 3: Implement** the rung (triggers off, `CREATE TABLE`/indexes byte-identical with
  `USER_SCHEMA_SQL`, the conversion reading each deck's uid in Rust and calling
  `todo_list_uid`, `ALTER TABLE decks DROP COLUMN todos`, `PRAGMA main.user_version = 59;`),
  then every census site. Rewrite `deck_todos.rs` with `lists_for`, `create_list`,
  `update_list`, `delete_list`, `every_list` and the five commands (reads: `#[tauri::command(async)]`
  sync fn over `lock_db_read`; writes: `async` + `spawn_blocking` + `with_write`, the existing
  shape). Update the module doc to the new model.
- [ ] **Step 4:** `cargo test --lib` in `src-tauri/` (**set `CARGO_INCREMENTAL=0` if D: is low on
  space**) and `cargo clippy --all-targets -- -D warnings` and `cargo fmt`. All green.
- [ ] **Step 5:** Report the files changed and any census site the tests found that this list missed.

### Task 2: The reader — `todoMarkdown.ts`

**Files:** Modify `src/features/decks/todoMarkdown.ts`, `src/features/decks/todoMarkdown.test.ts`.

**Interfaces:** Produces the Reader contract. Consumes `parseInlines`, `inlineText`, `HARD_BREAK`
from `noteMarkdown.ts`.

- [ ] **Step 1: Failing tests** — for the body below, `parseTodoBody` answers heading(2,"Mana",
  line 0), todos([Cut a land [Check curve (done)]]), text("Some notes about **why**." inlines
  bold, line 5), todos([Revise tokens]); `parseTodos` answers the two roots in order.

  ```
  ## Mana

  - [ ] Cut a land
    - [x] Check curve

  Some notes about **why**.

  - [ ] Revise tokens
  ```
  Also: every existing #672 case still passes unchanged except the "stray line reads as an open
  to-do" cases, which now expect a text block; `\- [ ] not a box` reads as text `- [ ] not a box`;
  a text line indented deeper than an open item still continues it; two text lines with no blank
  between are one paragraph; `# `, `## `, `### ` are headings and `#### x` is text; an empty list
  block is dropped; `isBlankList("", "- [ ] ")` is true, `isBlankList("Groceries", "")` false,
  `isBlankList("", "hello")` false; `listTitle("  ")` is `Untitled list`.
- [ ] **Step 2:** `npx vitest run src/features/decks/todoMarkdown.test.ts` — fails.
- [ ] **Step 3: Implement.** Extend the line loop: a top-level (not continuation) line matching
  `^ {0,3}(#{1,3})[ \t]+(.*)$` closes the stack and pushes a heading; a non-item line that is not a
  continuation closes the stack and starts or extends a text block (extends only if the previous
  non-blank line was text with no blank between); an item line after a text/heading block starts a
  new `todos` block. Unescape a leading `\` before `-`, `*`, `+`, `#` in text. Remove `todosText`
  and update the module doc (a to-do list is a document now; *nothing dropped* still holds — an
  unknown line is text).
- [ ] **Step 4:** Run the file — passes.

### Task 3: The editor — checklist mode as a to-do document

**Files:** Modify `src/features/decks/NoteEditor.tsx`, `src/features/decks/NoteEditor.test.tsx`.

**Interfaces:** Produces the Editor contract. Must write bodies Task 2 reads.

- [ ] **Step 1: Failing tests** — the checklist round-trip corpus gains: the Task 2 body above;
  `# Title\n\nplain words`; `- [ ] a\n\nbetween\n\n- [ ] b`; a paragraph whose words are
  `- [ ] literal` (assert what the editor writes and that it reads back as a paragraph — pin the
  escape the serializer actually emits). Behaviour tests: `Heading 2` on a to-do line makes a
  heading and leaves the to-dos after it a list; on a nested to-do its children stay a list;
  `Paragraph` on a to-do line makes a paragraph; `To-do` on a paragraph makes a to-do and joins
  the list above; Bold/Italic on a paragraph leave it a paragraph (no to-do created); Enter on an
  empty top-level to-do leaves a paragraph; `aria-pressed` reflects the caret's block;
  `appendRequest` after a trailing paragraph appends a new list with one empty to-do.
- [ ] **Step 2:** `npx vitest run src/features/decks/NoteEditor.test.tsx` — fails.
- [ ] **Step 3: Implement.** `ChecklistDocument.content = "(paragraph | heading | taskList)+"`,
  renderMarkdown joining with `"\n\n"`; add `NoteHeading` (levels 1–3) to
  `CHECKLIST_EXTENSIONS`; rewrite `oneListBody` → `todoDocBody` (keep paragraphs/headings, join
  adjacent task lists, turn other blocks into paragraphs of their words, empty → one empty to-do);
  `enterTodo`: empty top-level to-do → lift out to a paragraph (`liftListItem` from the top list);
  add a `blockToText(editor, kind)` helper that, when the caret is in a to-do, lifts that to-do's
  line out of every list (its sub-list stays as a list after it) and then `setParagraph` /
  `setHeading`; `To-do` uses `toggleList("taskList","taskItem")` when not in one. Toolbar buttons
  in checklist mode: marks, link, H1–H3, Paragraph, To-do, Outdent, Indent. Update
  `TODO_PLACEHOLDER` and the long comments that say "every line a to-do".
- [ ] **Step 4:** Run the file — passes.

### Task 4: IPC, keys, cross-window and the hooks

**Files:** Modify `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/crossWindow.ts`
(`TABLE_KEYS.deck_todo_lists: DECKS`), `src/features/home/keys.ts` (doc only),
`src/features/decks/useDeckTodos.ts` (rewrite to `useDeckTodoLists` + `useTodoListSave`).

**Interfaces:** Consumes the Rust contract; produces the TS contract.

- [ ] **Step 1:** Replace the three old ipc methods and the old `DeckTodoList` with the contract's
  five methods and two interfaces; `deckTodoListUpdate` sends `title ?? null`, `body ?? null`,
  `expected ?? null`. Update `ipc.test.ts`: command/arg cases for the five (the `desktop.rs`
  registration assertion included), struct-mirror rows `["DeckTodoList", deckTodosRs,
  "DeckTodoList"]` and `["DeckTodoListEntry", deckTodosRs, "DeckTodoListEntry"]`; drop the old
  cases. Also the `DeckRow`/`DeckPatch` docs that mention `decks.todos`.
- [ ] **Step 2:** Write the hooks per the contract, with the #672 module doc rewritten for rows.
- [ ] **Step 3:** `npx vitest run src/lib/ipc.test.ts src/lib/crossWindow.test.ts` — passes.

### Task 5: The band, the card and the dialog

**Files:** Modify `src/features/decks/DeckTodosPanel.tsx`, `DeckTodosPanel.test.tsx`,
`DeckTodosPanel.stories.tsx`. Create `src/features/decks/TodoListCard.tsx`,
`src/features/decks/TodoListDialog.tsx`, `src/features/decks/TodoListDialog.test.tsx`.

**Interfaces:** Consumes the TS, Reader and Editor contracts. `TodosBand` keeps plain props:
`{ open, onToggle, counts, onNewList, failure, lists: DeckTodoList[] | null, ticking: number | null,
onTick(list, line), onEdit(list), onDelete(list) }`.

- [ ] **Step 1: Failing tests** — band: cards in `sortOrder`; header count sums every list; a tick
  calls `deckTodoListUpdate(deckId, id, { body: next, expected: body })`; a `TODOS_CHANGED` refusal
  refetches and shows the sentence; Edit opens the dialog on that list; Delete confirms then
  deletes; empty state sentence; New to-do list opens the band and a dialog with no id. Dialog:
  typing then waiting 600 ms creates once, a second change updates the returned id (never a
  second create); closing blank creates nothing; closing after a title only creates with body
  `""`; a refused save keeps the draft; adopt-only-when-idle (the #672 band tests, moved).
- [ ] **Step 2:** Run the three test files — fail.
- [ ] **Step 3: Implement.** `TodoListCard` renders the frame, `listTitle`, `Edit`/`Delete`
  `RowAction`s, and `parseTodoBody` blocks (headings/text with the note card's prose classes,
  to-dos as real `<input type=checkbox>` named `Mark "<words>" done|not done`, dashed inert box when
  `toggleTodo` answers null). `TodoListDialog` moves the #672 wiring (`synced`, `draft`, `version`,
  `focused`, `pending`, `write`, `flush`, `owed`, unmount flush) out of `DeckTodosPanel`, adds the
  title input to the same draft, keys the scope per instance (`useId`), and has **Delete list** and
  **Done**. `DeckTodosPanel` keeps the header and becomes the grid + dialog host. Stories: the band
  with two lists (one with text), empty, refused read; the dialog new and existing.
- [ ] **Step 4:** Run the three files — pass.

### Task 6: The widget

**Files:** Modify `src/features/home/widgets/DeckTodosWidget.tsx`, `DeckTodosWidget.test.tsx`,
its stories file if present, and any `HomePage.test.tsx` mock of `deckTodoLists`.

**Interfaces:** Consumes `ipc.everyDeckTodoList`, `ipc.deckTodoListUpdate`, `parseTodos`,
`listTitle`.

- [ ] **Step 1: Failing tests** — two lists of one deck draw the deck heading once, then each
  list's title, then its to-dos; a list with nothing visible is left out; a tick sends that list's
  id with `expected` = its body; *Last edited* orders by a deck's newest list; *Most open* by the
  summed count; text lines never draw.
- [ ] **Step 2:** Run — fails.
- [ ] **Step 3: Implement.** `TodoDeck` gains `lists: { entry, items, counts }[]`; `TodoRow` gains
  `{ kind: "list", ... }` costing one line; the cache write on success replaces the entry's body
  by list id. Keep every empty sentence and switch.
- [ ] **Step 4:** Run — passes.

### Task 7: Storybook fake

**Files:** Modify `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts`.

- [ ] **Step 1:** Replace `FakeDeck.todos` with a `FakeDb.deckTodoLists` array; handlers for the
  five commands with the same refusals and ordering as Rust; cascade on `deck_delete`, clear on
  `decks_clear`, none copied on `deck_duplicate`; seeds convert each seeded `todos` into one list
  titled `To-do`, and add one seeded deck with two lists, one holding a heading and a paragraph.
  Update `db.test.ts`' todo cases and the write-handler count (re-count, never add).
- [ ] **Step 2:** `npx vitest run .storybook/fake/db.test.ts` — passes.

### Task 8: Docs

**Files:** `docs/reference/decks-storage.md` (*Deck to-dos*), `docs/reference/home-page.md` §16,
`src/features/decks/CLAUDE.md` (*The To-do band*), root `CLAUDE.md` (the sentence that says
`decks.todos`, one checklist to a deck at v58), and a pointer at the top of
`docs/superpowers/specs/2026-09-29-deck-todos-design.md` to the amendment.

- [ ] **Step 1:** Rewrite each to the new model in the file's own voice; state what #672 said and
  what replaced it. Count nothing a build answers.

### Task 9 (coordinator): fan-in

- [ ] `npm run verify`; fix what it finds; commit; push; PR with `Closes #688`; arm auto-merge
  and auto-fix; comment on the issue.
