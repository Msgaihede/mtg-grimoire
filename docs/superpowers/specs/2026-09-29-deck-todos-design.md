# Deck to-dos: a checklist under the notes, and a widget that gathers them

Issue [#672](https://github.com/Msgaihede/mtg-grimoire/issues/672). Reported through Discord by
**Giradeli** on the Luminia server.

> Provide a place to quickly note things to do, with the ability to link or point each item to a
> specific deck. — "Revise tokens" — Deck A, "Cut cards" — Deck B.

The brief as settled on 2026-09-29: a **To-do** band directly below the deck notes band; items the
reader can add, check off and delete; written in the rich text editor the notes already use;
nesting, so a to-do can carry sub-to-dos; and a home widget that tracks to-dos across decks and is
customizable the way every other widget is.

Two decisions were put to the reader and settled before this was written:

- **One checklist per deck, edited as one document**, over one row per to-do. The row model buys
  per-item sync merges and per-item dates at the price of a hand-built outliner — every item its own
  editor, with Enter, Tab, Backspace and reorder re-implemented across them. The checklist gets all
  four from the editor for free (§3).
- **The widget checks items off in place**, rather than being a read-only list that only opens decks.

Everything measured here was measured on Windows.

---

## 1. What is already true

| Need | Already exists | Where |
| --- | --- | --- |
| A rich-text editor over CommonMark | `NoteEditor` — `value` / `onChange` / `ariaLabel`, lazy, 141.5 kB gzip | `src/features/decks/NoteEditor.tsx:393` |
| Task items that nest, with markdown | `TaskList` / `TaskItem` in `@tiptap/extension-list@3.31.3` — `parseMarkdown`, `renderMarkdown` through `renderNestedMarkdownContent`, and `nested: true` for Tab / Shift-Tab | installed transitively under `@tiptap/starter-kit`; **nothing turns it on today** |
| An inline markdown reader | `parseInlines` — bold, italic, strike, code, links, hard breaks | `src/features/decks/noteMarkdown.ts:229`, **not exported yet** |
| Autosave on a debounce, flushed on unmount | `StickyNoteDialog` — `SAVE_DELAY_MS = 600` | `src/features/home/StickyNoteDialog.tsx:100` |
| A per-deck band disclosure that syncs | `decks.notes_open` (v43), `tokens_open`, `stats_open` | `schema.rs:6939`, `capture.rs:430` |
| A widget with a deck picker | `deckCompletion` — `scope` all / chosen + `DeckCompletionWidgetSettings` | `widgets.ts:503`, `DeckCompletionWidget.tsx:608` |
| Opening a deck from a widget | `setActiveView("decks")` **then** `setOpenDeckId(id)` — the order is pinned by tests | `DeckCompletionWidget.tsx:542` |

**The one import rule that binds.** `DeckNotesPanel.test.tsx` sweeps every source file for a static
import of `NoteEditor` (that includes importing `NOTE_EXTENSIONS` from it). The band reaches the
editor through `React.lazy` exactly as `NoteEditorDialog.tsx` and `StickyNoteDialog.tsx` do, and the
widget never loads the editor at all.

---

## 2. The model: a to-do list is not a note

⚠️ **A to-do is not a note.** The root `CLAUDE.md` already warns that *deck note*, *card note*,
*entry note* and *sticky note* are four different things that share one word. A **deck to-do list**
is a fifth thing that shares their *editor* and their inline dialect, and nothing else:

| Thing | Stored | Spelled |
| --- | --- | --- |
| a **deck note** | rows, many to a deck, with card attachments | `deck_notes`, `DeckNote` |
| a **sticky note** | rows, attached to nothing | `sticky_notes`, `StickyNote` |
| a **deck to-do list** | one column on the deck, one list to a deck | `decks.todos`, `deckTodos` |
| a **to-do** | one line of that list — not a row anywhere | `TodoItem` (TS only) |

**A deck has exactly one to-do list, and it is a property of the deck**, the way its bracket or its
token mode is. That is what lets it live on the `decks` row rather than in a table of its own (§4).

**A to-do has no identity outside its list.** It is a line of markdown; it has no id, no creation
date and no sync uid. The widget names one by its **source line** in the body it read (§5), and the
compare-and-set write (§5) is what makes that name safe to act on.

---

## 3. The editor's checklist mode

`NoteEditor` gains one optional prop, `mode?: "note" | "checklist"`, default `"note"`. Every existing
caller is unchanged. Checklist mode:

- **The document is one task list.** `Document.extend({ content: "taskList" })`, so every line is a
  to-do and there is no way to type a paragraph outside one. An emptied document is one empty task
  item, which ProseMirror's content expression creates on its own.
- **Extensions.** `TaskList` and `TaskItem.configure({ nested: true })` join the kit. Bold, italic,
  strike, code, link, hard break, undo/redo and the placeholder stay. Headings, bullet and ordered
  lists and blockquote are **off** — `NOTE_EXTENSIONS`' rule that every "off" is written out holds,
  so the checklist kit is a second explicit list, `CHECKLIST_EXTENSIONS`, beside the first.
- **`@tiptap/extension-list` becomes an explicit dependency** at exactly the version starter-kit
  already resolves (`3.31.3`), so the import is not reaching into another package's transitive tree.
- **Keyboard**, all of it TaskItem's own: Enter makes a new to-do, Tab nests it under the one above,
  Shift-Tab lifts it out, Backspace in an empty to-do removes it.
- **Toolbar.** The marks, link, then **Outdent** and **Indent** (`liftListItem` / `sinkListItem`).
  No heading, list or quote buttons — they would do nothing in a document that can hold none of them.
- **A delete button on every row.** `TaskItem.extend({ addNodeView })` wraps the parent's node view
  (`this.parent?.()`) and appends one `contentEditable=false` button to its `dom`, visible on hover
  and on focus-within. It deletes the item **with its sub-to-dos** — a sub-to-do belongs to its
  parent — and deleting the only item leaves one empty one. Ctrl+Z brings it back; that is the
  editor's history and it is the only undo the list has (§5).
- **Accessible names.** `TaskItem`'s `a11y.checkboxLabel` names each checkbox after its text —
  "Mark "Revise tokens" done" / "Mark "Revise tokens" not done" — and the delete button is "Delete
  "Revise tokens"".
- **Appending on request.** The band's **New to-do** button must put the caret on a fresh item at the
  end. `NoteEditor` gains `appendRequest?: number` in checklist mode: when it changes, the editor
  appends an empty item (unless the last one is already empty) and focuses it. A counter rather than
  a boolean, so a second press is a second request.

### The dialect is Tiptap's own serialization, pinned by a round trip

The stored body is what `TaskItem.renderMarkdown` writes: `- [ ] text` / `- [x] text`, sub-to-dos
indented under their parent by `renderNestedMarkdownContent`. **The exact indent width is measured,
not assumed** — the first implementation task round-trips a committed corpus through the editor and
pins whatever the renderer emits, byte for byte, as `NoteEditor.test.tsx` already does for notes.
The reader in §6 compares indent *widths* against a stack rather than dividing by a constant, so it
holds whatever that measurement says.

---

## 4. Storage — user schema v58

⚠️ **57 is the head today (`schema.rs:611`), so this is 58 — but take the next free number at the
moment you land, never at the moment you start.** `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs`
is the only thing that settles it.

```sql
ALTER TABLE decks ADD COLUMN todos TEXT NOT NULL DEFAULT '';
ALTER TABLE decks ADD COLUMN todos_open INTEGER NOT NULL DEFAULT 0;
```

- **`todos`** — the checklist, in §3's dialect. Empty means the deck has no list.
- **`todos_open`** — whether the band is expanded. `notes_open`'s twin one column along, and
  **`DEFAULT 0` for `notes_open`'s reason** (`schema.rs:6883`): a collapsed default takes nothing from
  anybody.

**Why two columns and not a table.** One list to a deck is a column's shape. A table would owe the
twelve-site synced-table census, a `sync_uid`, a uid index and a **grain** on `deck_id` — and a grain
means two devices each writing a deck's first to-do while apart fold into one row by the grain rules.
Two columns owe none of that and inherit everything `decks` already has: the delete cascade (a
deleted deck's list goes with its row), the change mask, the capture trigger.

### Sync: both columns join the `decks` capture spec

Per-field last-writer-wins (`capture.rs:48`) is what makes this safe: a to-do edit on one device and
a rename on another touch different fields and both survive. **Adding is the safe direction**
(`capture.rs`, the note above `theory_mark_exact`): a v57 peer's `apply` walks its *local* spec and
never asks for `todos`, and a v58 device receiving a v57 op finds the key absent and leaves the
column alone.

- `todos_open` travels for `tokens_open`'s stated reason: a reader who opened the band on one device
  meant it about the deck.
- ⚠️ **The honest cost of one-document storage: two devices editing the same deck's list while apart
  → the later write wins, whole.** Deck note bodies already behave exactly this way, and it is the
  price the reader chose, above, over a hand-built outliner.

### Everything else the rung owes

- `USER_SCHEMA_SQL`'s `decks` statement gains the two columns at its tail, **byte-identical** to what
  `ALTER TABLE … ADD COLUMN` writes into `sqlite_master` —
  `the_user_schema_is_byte_identical_to_what_the_ladder_builds` is the fence.
- `UNDO_V58` — `ALTER TABLE decks DROP COLUMN todos_open; ALTER TABLE decks DROP COLUMN todos;` — at
  the **front** of every rewind chain. `grep -c '{UNDO_V57}' schema.rs` counts them; do not trust a
  number written anywhere, this one included.
- The hard-coded head assertions (`assert_eq!(…, 57)`) move to 58. `cargo test --lib schema::tests`
  finds the ones a list misses.
- `DeckRow` / `deck_row` gain `todos_open` (read the column index off `deck_row`, never off a doc),
  and `DeckPatch` gains it so the band's disclosure rides the existing deck update.
- **`todos` does not go on `DeckRow`.** Every deck list fetches `DeckRow`s; a body travels only
  through §5's two reads.
- **`duplicate_deck` does not copy `todos`.** A copy that carried its original's list would put every
  open to-do in the widget twice, and ticking one would leave its twin open. `todos_open` is not
  copied either; the copy starts collapsed.
- **Text mirror.** `decks` already maps to `DECKS_ONLY` in `mirror::watch::surface_of`, so a to-do
  write costs one mirror pass that renders identical bytes — `deck_notes`' accepted cost, verbatim.
  To-dos appear in no mirror file, export or share.
- **Multi-window.** Nothing to register: `decks` is already on `userTables.json` and maps to the
  `["decks"]` key in `crossWindow.ts:131`, which is the prefix both of §5's query keys sit under.

---

## 5. The boundary

### Rust supplies facts — `src-tauri/src/deck_todos.rs`

Pure functions over `&Connection`, command wrappers in one `#[cfg(not(target_family = "wasm"))]`
block at the foot — `deck_notes.rs`'s shape.

| Command | Answers |
| --- | --- |
| `deck_todos(deck_id)` | the body; refuses `DECK_GONE` |
| `deck_todos_set(deck_id, body, expected?)` | `()` — see below |
| `deck_todo_lists()` | every deck whose `todos <> ''`: `{ deckId, name, archived, updatedAt, body }` |

**`deck_todos_set` is a compare-and-set when `expected` is given.** The update is
`UPDATE decks SET todos = ?2, updated_at = … WHERE id = ?1 AND (?3 IS NULL OR todos = ?3)`; zero rows
changed is `DECK_GONE` if the deck is missing and `TODOS_CHANGED` otherwise. Both refusals are
`pub const` sentences, `deck_notes.rs`' convention.

- **The band writes without `expected`.** It is the author's surface and its autosave is the truth of
  what the reader typed.
- **The widget always sends `expected`** — the body it parsed. A tick is "flip the marker on line
  *n* of **this** text", and the text may have moved since: the band autosaving in another window, a
  sync apply. A refused tick refetches rather than guessing.

**What a write does beyond the column.** It bumps the deck's `updated_at` (`touch_deck`), as a deck
note does, so a deck the reader just worked through reads as recently edited. It writes **no
`deck_audit` row and no `deck_undo` step**: an autosave every 600 ms of typing would flood the
history panel with one line per pause, and the editor's own Ctrl+Z is the undo. `sticky_notes.rs`
made the same call for the same reason.

Registration: `lib.rs`' module map, `desktop.rs`' `generate_handler!`, `web::route`'s `COMMANDS` and
its `match` arm. **A miss is `unknown command` at runtime with nothing red.** No capability entry —
app commands take none.

### TypeScript draws conclusions — `src/features/decks/todoMarkdown.ts`

Pure, tested, no React.

- `parseTodos(body): TodoItem[]` — a tree. Each item: `done`, `inlines` (through `parseInlines`,
  which `noteMarkdown.ts` now exports), `line` (0-based source line of its marker), `children`.
  - An item line is `^(\s*)[-*+] \[( |x|X)\](?: (.*))?$`. Depth comes from comparing indent widths
    against a stack, never from dividing by a constant (§3).
  - A non-blank line that is not an item and is indented at least as deep as the item above it is a
    continuation of that item (a hard break), joined with `"\n"`.
  - **Nothing is dropped for not being understood** — `noteMarkdown.ts`' rule. Any other non-blank
    line reads as an open to-do with that text. No path writes such a line today; the rule exists so
    a body from a future build still shows every line.
- `countTodos(items) → { open, done }` — every item counts, at every depth.
- `toggleTodo(body, line) → string | null` — flips exactly the marker on that line and touches no
  other byte; `null` if that line is not an item line.
- `visibleTodos(items, { showDone, nested })` — the widget's filter. With completed hidden, **a done
  item stays if it still has an open descendant**, drawn done, so a tree never loses the parent its
  open child sits under. With sub-to-dos off, only top-level items show.

---

## 6. The band — `DeckTodosPanel`

Mounted in `DeckEditor.tsx` **directly after `DeckNotesPanel`** (`:6053`), gated on `row` as that one
is. It follows the notes band's header grammar (`DeckNotesPanel.tsx:637`) — split into wiring
(`DeckTodosPanel`) and drawing (`TodosBand`, plain props, for the stories):

- `<section aria-label="To-do" className="shrink-0 border-t border-border pt-3">` — a section, never
  an aside; `shrink-0` is mandatory.
- A disclosure button with `aria-expanded` / `aria-controls` and the rotating chevron, writing
  `deck.update.mutate({ todosOpen })`.
- A mono count — `3 open · 2 done`, or nothing for an empty list.
- **New to-do** at `ml-auto` (`META_SUBMIT`): opens the band if it is closed and bumps
  `appendRequest`.

**The open body is the checklist editor**, lazy behind `Suspense` with a sentence for the fallback,
inside a `select-text` surface (the editor root is `select-none`; `src/features/decks/CLAUDE.md`).

**Saving.** Autosave 600 ms after the last change, flushed on blur and on unmount —
`StickyNoteDialog`'s behaviour and its constant. The count in the header is computed from the draft,
so it moves as the reader ticks.

**Adopting a change from elsewhere.** The band's query (`["decks", "todos", deckId]`) refetches when
the widget ticks an item or another window writes. The editor takes the new body **only when it is
not focused and holds no unsaved edit**; otherwise the reader's typing wins and the next autosave
overwrites. That is the one-document cost of §4 stated at its sharpest, and it is deliberate: losing
a tick made elsewhere is recoverable at a glance, losing a sentence mid-type is not.

**Empty.** A deck with no list shows the editor with one empty item and the placeholder *"Add a
to-do — Enter for the next, Tab to nest."*

---

## 7. The widget — `deckTodos`

The widget is `deckTodos`; the columns are `decks.todos`; the word on screen is **To-dos**.

```ts
deckTodos: {
  label: "To-dos",
  description: "Open to-dos from every deck's To-do band, ticked off where they stand.",
  def: [3, 3],
  min: [2, 2],
  max: [6, 6],
  picks: [
    { key: "scope", label: "Which decks", options: [
      { id: "all", label: "All decks" },
      { id: "chosen", label: "Chosen…" },
    ]},
    { key: "order", label: "Order", options: [
      { id: "edited", label: "Last edited" },
      { id: "name", label: "Name" },
      { id: "open", label: "Most open" },
    ]},
  ],
  toggles: [
    { key: "done", label: "Show completed", dflt: false },
    { key: "nested", label: "Show sub-to-dos" },
    { key: "archived", label: "Include archived decks", dflt: false },
    { key: "counts", label: "Show open count" },
  ],
  chip: "scope",
},
```

- ⚠️ `RESERVED_KEYS = ["title", "density"]` — neither is used.
- **Chosen decks** reuse `deckCompletion`'s picker: `renderExtraSettings` draws a `MultiDropdown`
  writing `{ deckIds, scope: "chosen" }`, read back with `pinnedDeckIds`.
- **It does not join `DEFAULT_LAYOUT`** — every kind since `newPrintings` has been catalogue-only, and
  the default layout is an exact 8×7 rectangle held in three copies.
- ⚠️ `widgets.test.ts` pins `WIDGETS.slice(-4)` to round two's four kinds, so appending this row
  moves that assertion; update it to name what it means rather than to a new count.

**The body.** One query, `["decks", "todos", "lists"]` over `deck_todo_lists`, filtered and ordered
in TS. Grouped by deck:

- A **deck heading** — the deck's name, and the open count when `counts` is on. Pressing it opens
  the deck **with its To-do band expanded**: `deck.update({ todosOpen: true })` when it is closed,
  then `setActiveView("decks")`, then `setOpenDeckId(id)` — the order `DeckCompletionWidget` pins.
- Under it, the to-dos from `visibleTodos`, sub-to-dos indented one step per level. The inline text
  renders through the widget's own `Inline` components with **`whitespace-pre-line`** (a hard break
  is a `"\n"` inside a run).
- **The checkbox ticks in place**: `toggleTodo(body, line)` → `deck_todos_set(deckId, next, body)`.
  The row greys while the write is in flight. `TODOS_CHANGED` refetches and says "That deck's list
  changed — try again." in the widget's one-line failure slot.
- Decks with nothing visible (every to-do done and completed hidden) are left out. Rows are whole
  rows, cut with `fit.fitCount`; what does not fit is summarised by a `+N more` footer.

**The fences on `WidgetBodyProps`.** `still` (the catalogue preview): nothing ticks, nothing
navigates, the scroller clips. `editing` (Customize): the page makes the body inert, so a press is a
pick-up.

**Empty.** "No to-dos yet" and one dim line — "Add them in any deck's To-do band." A read failure is
`WidgetMessage`'s sentence.

---

## 8. Testing

- **Rust.** The rung and its rewind (`UNDO_V58` first in every chain), byte identity, the capture spec
  carrying both fields, `duplicate_deck` leaving both behind, and `deck_todos.rs`' own module:
  the set/read round trip, `expected` matching and refusing (`TODOS_CHANGED`, `DECK_GONE`),
  `deck_todo_lists` leaving empty lists out.
- **The cross-boundary fence.** `ipc.test.ts` rows for all three commands and for `DeckRow` /
  `DeckPatch`'s new field.
- **The dialect.** `todoMarkdown.test.ts` over a committed corpus: nesting at the measured indent,
  continuation lines, the nothing-dropped rule, `toggleTodo` changing exactly one byte, and
  `visibleTodos`' done-parent-with-open-child rule.
- **The editor.** Checklist mode's round trip, byte for byte, over the same corpus — this is the test
  that pins §3's indent — plus Enter / Tab / Shift-Tab, the row delete (with children; last item),
  and `appendRequest`.
- **The band.** Disclosure, the count from the draft, autosave and flush, and adopt-only-when-idle.
- **The widget.** Grouping, both orders, each toggle, the tick's compare-and-set and its refusal,
  heading navigation order, `still`, and the empty state. `HomePage.test.tsx` gets a mock and both
  switch cases (⚠️ its negative checks look for `/came from a newer version/`, which never matches —
  use `/needs a newer version/`).
- **Storybook.** Fake handlers for the three commands in `allHandlers`, seeded lists, a `TodosBand`
  story and a `DeckTodosWidget` story. A story reaches `NoteEditor` only through an `import()`.
- **Live.** The band and the widget driven in the real window over CDP before the PR is called done.

---

## 9. Out of scope

- **Dates on a to-do** — created, completed, due. A line of markdown has nowhere to keep one, and the
  row model that would was the option not taken.
- **To-dos that belong to no deck.** The issue's example names a deck on every item; a global list
  is a sticky note.
- **To-dos in the text mirror, an export format, or a share.** Each would need a field-registry entry
  and a golden-corpus row.
- **Deck history and undo rows for to-do edits** (§5).
- **Dragging to-dos** between positions or decks. Tab / Shift-Tab and the editor's own cut and paste
  are the reorder.
