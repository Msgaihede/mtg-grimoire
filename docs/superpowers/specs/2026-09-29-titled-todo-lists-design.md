# Titled to-do lists with free text

Issue [#688](https://github.com/Msgaihede/mtg-grimoire/issues/688). Reported through Discord by
**Supreme** on the Soup Dev server.

> Make to-do lists match the style of notes, support multiple lists, and allow users to add text
> in the editor instead of requiring every line to be a to-do item.

This **amends** [the deck to-dos design](2026-09-29-deck-todos-design.md) (issue #672, user schema
v58). Two of that document's settled decisions are reversed here, by the owner, on 2026-09-29:

- **One checklist per deck → several titled to-do lists per deck**, drawn as cards the way the
  deck notes are.
- **Every line a to-do → a to-do document**: paragraphs and headings sit beside any number of task
  lists, and the toolbar's heading buttons and a new **P** button make a line text rather than a
  to-do.

Three more were put to the owner and settled before this was written:

- **A card ticks in place.** A list is drawn read-only on its card and its boxes tick there,
  through the compare-and-set write the widget already uses. Pressing the card or **Edit** opens a
  dialog with a title field and the editor, which autosaves as the band does today.
- **New to-do list opens that dialog on an unsaved list**, and its first real change is the
  create; a dialog closed untouched creates nothing.
- **The widget is deck → list title → to-dos.** Text is not drawn there.

Everything the #672 design says that this document does not contradict still holds — the lazy
editor rule, the autosave's mechanics, the compare-and-set, the widget's switches.

---

## 1. The model

| Thing | Stored | Spelled |
| --- | --- | --- |
| a **deck to-do list** | rows, many to a deck, each with a title | `deck_todo_lists`, `DeckTodoList` |
| a **to-do** | one checkbox line of a list's body — not a row anywhere | `TodoItem` (TS only) |
| **text** in a list | a paragraph or heading of that body | `TodoBlock` (TS only) |

⚠️ **Still not a note.** A to-do list now has a title, a body and a card, which is exactly the
shape a deck note has — so the root `CLAUDE.md`'s warning is sharper, not weaker. It shares the
notes' editor, their inline dialect and their card *look*; it has no card attachments, no
masonry drag, no Save button, and no row in `deck_notes`.

---

## 2. Storage — user schema v59

⚠️ Take the next free number at the moment you land (`grep USER_SCHEMA_VERSION
src-tauri/src/schema.rs`). 58 is the head today.

```sql
CREATE TABLE deck_todo_lists (
  id INTEGER PRIMARY KEY,
  deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
, sync_uid TEXT);
CREATE INDEX idx_deck_todo_lists_deck ON deck_todo_lists (deck_id, sort_order);
CREATE UNIQUE INDEX idx_deck_todo_lists_uid ON deck_todo_lists (sync_uid);
```

The shape is `deck_notes`' (v43), column for column where the two mean the same thing, so the
`sync_uid` line break and `sort_order` are its spellings rather than new ones.

**The conversion runs inside the rung, with capture off, and names each row by derivation** —
v53's `theory_pile_uid` move, not v52's launch pass:

- Every deck with `todos <> ''` gets one row: title **`To-do`**, body the column, `sort_order 0`,
  `created_at`/`updated_at` the deck's `updated_at`.
- Its `sync_uid` is `todo_list_uid(deck_uid)` — lowercase hex of the first 16 bytes of SHA-256
  over `deck_todo_lists/legacy/<deck uid>`. Every device in a group converts its own copy of the
  same deck's list and names the row the same way, so the next edit on any of them lands on the
  same row everywhere with nothing announced. A deck with no uid gives a row with none; the mint
  names it later like any other row.
- Then `decks.todos` is **dropped** — the three `decks` capture triggers first, v43's move,
  because SQLite refuses a `DROP COLUMN` on a column a trigger reads. `capture::install` puts them
  back. `decks.todos_open` stays: it is the band's disclosure, and still rides `DeckRow` /
  `DeckPatch`.

**What the census owes** (`docs/reference/sync.md` and `src-tauri/CLAUDE.md` hold the list): the
rung; `USER_SCHEMA_SQL` (the table, both indexes, and the `decks` line without `todos`); the
byte-identity count; `UNDO_V59` at the front of every rewind chain (drop the table and indexes,
drop the `decks` triggers, add `todos` back in v58's exact shape); every head literal 58 → 59;
`schema::TABLES`; `SYNCED_TABLES` (17 → 18); a `capture::Spec`
(`fields: title, body, sort_order`, parent `deck` → `decks`, `Absent::Null`, not soft) and
`todos` off the `decks` spec; an `apply::Meta` (next free `order`, no grain — uid-only, as
`deck_notes`); `mirror::watch::surface_of` → `DECKS_ONLY` (no mirrored file names a list;
`deck_notes`' argument); `userTables.json`, `syncedTables.json` and `crossWindow.ts`'
`TABLE_KEYS` (→ `DECKS`, which covers `["decks","todos",…]`).

- **`duplicate_deck` copies no list** — the #672 reason: a copy would draw every open to-do in the
  widget twice. **A deck delete cascades**, and its undo restores no list, which is what the
  column did (`deck_undo.rs` excluded it).
- **No audit row, no undo step, no activity row** for a list write — #672 §5's reason.
- ⚠️ **The mixed-version cost.** A v58 peer's edits to `decks.todos` are ignored by a v59 device
  (the column is gone from its spec, `a_field_this_build_no_longer_syncs_is_skipped_rather_than_stalling`),
  and a v58 peer holds a v59 sender's stream on the unknown table until it upgrades. The groups
  this app has are one reader's devices; the cost ends at the update.

---

## 3. The boundary

### Rust supplies facts — `src-tauri/src/deck_todos.rs`, rewritten

| Command | Args | Answers |
| --- | --- | --- |
| `deck_todo_lists` | `deckId` | `DeckTodoList[]` for the deck, `sort_order, id`. `[]` for an unknown deck. |
| `deck_todo_list_create` | `deckId, title, body` | the new `DeckTodoList`, at the end (`max(sort_order)+1`). `DECK_GONE` for an unknown deck. |
| `deck_todo_list_update` | `deckId, id, title?, body?, expected?` | `()`. Either field may be `null` (unchanged). |
| `deck_todo_list_delete` | `deckId, id` | `()`. Idempotent on a row already gone. |
| `every_deck_todo_list` | — | `DeckTodoListEntry[]` — every list with a non-empty body, with its deck's `name`, `archived` and `todosOpen`; `updated_at DESC, id`. |

`DeckTodoList` is `{ id, deckId, title, body, sortOrder, createdAt, updatedAt }`;
`DeckTodoListEntry` is `{ id, deckId, deckName, archived, todosOpen, title, body, updatedAt }`.

**`deck_todo_list_update`** reads and writes in one transaction, and refuses in this order: a
list that is not there is `TODO_LIST_GONE`; a list on another deck is `TODO_LIST_WRONG_DECK`;
`expected` given and not equal to the stored body is `TODOS_CHANGED` (the #672 sentence, kept);
a title and body both equal to the stored ones write nothing at all. Otherwise it writes both
columns and `updated_at = unixepoch()`, and bumps the deck's `updated_at` in the same
transaction. **Create and delete bump the deck's `updated_at` too.** Refusals are `pub const`
sentences.

The three #672 commands (`deck_todos`, `deck_todos_set`, the old `deck_todo_lists`) are removed.

### TypeScript draws conclusions — `src/features/decks/todoMarkdown.ts`

The dialect is what the editor writes (§4): blocks separated by one blank line — `# `/`## `/`### `
headings, paragraphs, and task lists in #672's shape (`- [ ]` / `- [x]`, two spaces per nesting
level).

- **`parseTodoBody(body): TodoBlock[]`** — `{ kind: "heading", level, inlines, text, line }`,
  `{ kind: "text", inlines, text, line }`, or `{ kind: "todos", items: TodoItem[] }`.
  - A line at the top level (not a continuation) that starts `#`–`###` and a space is a heading.
  - An item line is #672's `ITEM`, depth by width against a stack.
  - A non-blank line that is not an item continues the open item when #672's rule says so (deeper
    indent, or a hard break above). **Otherwise it is text** — where #672 read it as an open to-do.
    Consecutive text lines are one paragraph (joined with a space, or `"\n"` after a hard break);
    a blank line ends it. A heading or text block closes every open item, so an item after it
    starts a new list.
  - The empty to-do rule stands: an empty item with nothing under it is dropped. A list block
    left with no items is dropped.
- **`parseTodos(body): TodoItem[]`** — every list's top-level items, in order, concatenated. Its
  callers (counts, the widget) do not change.
- `countTodos`, `toggleTodo`, `visibleTodos`, `sameTodos` — unchanged in meaning. `sameTodos`'
  normaliser drops empty to-dos as before and leaves text alone.
- **`todosText` is removed**: a list with only text in it is a list, and an empty body is stored
  as `""` by whoever wrote it.
- **`isBlankList(title, body)`** — true when the title trims to nothing and `parseTodoBody` finds
  no block. The dialog's *closed untouched creates nothing* test.

---

## 4. The editor — `NoteEditor`'s `mode="checklist"`, widened

The name stays; the document changes from *one task list* to **a to-do document**:

- **`ChecklistDocument`'s content is `(paragraph | heading | taskList)+`.** Heading levels 1–3 are
  on (the note's `NoteHeading`); bullet and ordered lists, blockquote, code block, rule and hard
  break stay off, for #672's reasons.
- **`oneListBody` becomes a repair that keeps text**: paragraphs and headings pass through; a
  stray block the schema cannot hold (a bullet list, a quote) becomes a paragraph of its words;
  adjacent task lists are joined into one; an empty document is one empty to-do.
- **Toolbar, in order**: marks and link as today; then **H1, H2, H3, P, To-do**; then Outdent and
  Indent.
  - **H*n*** makes the caret's line a heading. On a to-do's line it first lifts that line out of
    every list — its sub-to-dos stay a list below it — then sets the heading. Pressing the lit one
    turns the line back into a paragraph.
  - **P** makes the line a paragraph, lifting it out of every list the same way. Lit when the
    caret is in a top-level paragraph.
  - **To-do** makes the line a to-do: a paragraph or heading is wrapped in a task list (joined to
    a list directly above or below it). Lit when the caret is in a to-do.
  - **Bold, italic, strike, code and link never change the block**, so none of them makes a to-do.
- **Keys.** Enter on a to-do with words: the next to-do (unchanged). **Enter on an empty
  top-level to-do lifts it out as a paragraph** — the list ends where the reader stopped. Enter on
  a paragraph or heading: ordinary (a heading's Enter makes a paragraph). Backspace at the start
  of a top-level paragraph directly under a list: ordinary join. #672's Backspace, Delete and
  Shift-Tab answers stand for to-do lines.
- **The placeholder** reads *"Write, or add a to-do — Enter for the next, Tab to nest."*
- `appendRequest` stays and appends an empty to-do at the end (after a text block it starts a new
  list).

The committed checklist corpus in `NoteEditor.test.tsx` gains bodies with headings, paragraphs and
two lists, and pins the round trip byte for byte; `todoMarkdown.test.ts` reads the same bodies.

---

## 5. The band — `DeckTodosPanel`

Header as #672 (`To-do`, the count, the button), with the button renamed **New to-do list**. The
count sums `parseTodos` over every list.

**The open body is a grid of cards**, one per list in `sort_order`, drawn in `NoteCard`'s frame
(the surface box, the title in its weight, `Edit` and `Delete` as `RowAction`s) — not
`NoteCard` itself, which draws card art and a drag handle a list does not have. A single-column
stack at narrow widths, two tracks when the band is wide. The body renders `parseTodoBody`'s
blocks with **no editor**: headings and text in `PROSE`'s steps, to-dos as #672's widget draws
them (box, words, indent per level, done struck through).

- **A box ticks in place**: `toggleTodo(body, line)` → `deck_todo_list_update(deckId, id, null,
  next, body)`. A success writes the new body into the cache at once; `TODOS_CHANGED` refetches and
  shows the sentence on the band's alert line. While one tick is out every box on that card is
  `aria-disabled`.
- **Edit, or a press on the card outside a box**, opens `TodoListDialog` on that list.
- **Delete** asks first (`CONFIRM_DESTRUCTIVE`, "Delete "<title>"? Its to-dos go with it.") and
  then deletes.
- An untitled list is drawn as **Untitled list**.
- **Empty**: no lists → one dim line, *"No to-do lists yet. New to-do list starts one."*

### `TodoListDialog`

`Dialog` with a title `<input>` (placeholder `Title`) and the lazy `NoteEditor` in checklist mode
under it. **It owns #672's autosave, moved from the band intact**: the 600 ms timer, the flush on
blur and on close, the one-at-a-time saves under a TanStack `scope`, the cancel of in-flight reads
in `onSuccess`, adopt-only-when-idle, and *a refused write leaves the draft on screen and owed*.
The title rides the same save as the body.

- **A new list has no id until its first save**, which is the create; later saves update the id it
  answered. The scope is per dialog instance, so an update queued behind the create waits for the
  id.
- **Closed untouched** (`isBlankList`) creates nothing.
- **Delete list** in the dialog's footer, behind the same confirm. **Done** closes (flushing).
- Opening the dialog from **New to-do list** opens the band too, `todos_open`'s write.

---

## 6. The widget — `deckTodos`

One query, `["decks", "todos", "lists"]` over `every_deck_todo_list`. Grouped by deck, then by list:

- The **deck heading** as #672 (name, open count summed over its lists, the press that opens the
  band).
- Under it, **each list's title** as a subheading row (`Untitled list` when empty), then its to-dos
  from `visibleTodos(parseTodos(body))`. Text is not drawn. A list with nothing visible is left
  out; a deck with no list left is left out.
- **A tick** is `deck_todo_list_update(deckId, id, null, next, body)` — the list's own
  compare-and-set.
- **Last edited** orders decks by their newest list's `updatedAt`; **Most open** by the deck's
  summed open count. The row-cost cut counts a list heading as one line.
- Every setting, empty sentence and fence (`still`, `editing`) stands.

---

## 7. Testing

- **Rust**: the rung (a deck with a list converts to one row titled `To-do` with the derived uid;
  a deck without one converts to nothing; `todos` is gone), the rewind, byte identity, every
  census fence, and `deck_todos.rs`' module — create/read/update/delete, the three refusals, the
  no-change write, the deck's `updated_at`, the cascade, and `every_deck_todo_list`.
- **`ipc.test.ts`**: rows for the five commands and both structs.
- **The dialect**: `todoMarkdown.test.ts` over the corpus — headings, text, two lists, text that
  used to read as a to-do, continuation still winning over text.
- **The editor**: the round trip; H*n*, P and To-do on a to-do line, a nested to-do and a
  paragraph; marks never changing the block; Enter on an empty top-level to-do.
- **The band and dialog**: cards in order, tick in place and its refusal, Edit opens the dialog,
  delete with confirm, New to-do list → create on first change, closed untouched creates nothing,
  #672's autosave cases moved over.
- **The widget**: the list subheading, per-list ticks, both orders.
- **Storybook**: fake handlers and seeds for the five commands; band, dialog and widget stories.

---

## 8. Out of scope

- **Reordering lists** by drag. New lists go at the end; `sort_order` exists so a later reorder is
  a command rather than a rung.
- **Moving a list to another deck.**
- Everything #672 §9 listed: dates, to-dos in the mirror, exports or shares, history rows.
