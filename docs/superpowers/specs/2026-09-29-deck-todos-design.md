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

> **Amended 2026-09-29, after the build.** Where building it showed this document wrong, the
> section now says what shipped and names what it replaced: §3's hard break is **off** and §3's
> keyboard is not all `TaskItem`'s own; §4's mirror surface is `DECKS_AND_COLLECTION`, not
> `DECKS_ONLY`; §5's read of an unknown deck answers `""` rather than refusing; §5 names no web
> router, because this tree has none; §5's continuation line is one indented **deeper** than its
> item, or one after a hard break; §6's saves run **one at a time** and cancel stale reads; and §7
> has two more empty sentences, a dashed box for a line with no box, and a cut that clamps. The
> record of what shipped is [decks-storage.md](../../reference/decks-storage.md)'s *Deck to-dos*,
> [home-page.md](../../reference/home-page.md) §16 and `src/features/decks/CLAUDE.md`'s *The To-do
> band*.

> **Amended 2026-09-29 again, by [issue #688](https://github.com/Msgaihede/mtg-grimoire/issues/688)
> and [the titled to-do lists spec](2026-09-29-titled-todo-lists-design.md).** The owner reversed two
> of the decisions settled above: **one checklist per deck** became several titled lists per deck,
> rows of `deck_todo_lists` at user schema v59 that `decks.todos` was converted into and then
> dropped; and **every line a to-do** became a to-do document, headings and paragraphs beside any
> number of task lists, where a line that is not a to-do reads as text rather than as §5's open
> to-do. §2's table, §4's `todos` column (`todos_open` stands), §5's three commands and §6's
> editor open in the band describe v58 and no longer the tree — the editor and its autosave moved
> into a dialog per list; everything here that the newer spec does not contradict still holds. The same three records above
> carry what replaced it.

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
  strike, code, link, undo/redo and the placeholder stay. Headings, bullet and ordered lists,
  blockquote **and hard break** are **off** — `NOTE_EXTENSIONS`' rule that every "off" is written
  out holds, so the checklist kit is a second explicit list, `CHECKLIST_EXTENSIONS`, beside the
  first.
  - ⚠️ **Amended: this bullet kept hard break, and the build turned it off.** Its markdown is
    `"  \n"` with the rest of the line unindented, and `TaskList`'s markdown tokenizer reads a task
    item one line at a time, so the second half of a broken to-do comes back as a paragraph
    *outside* the list — which a document whose content is `taskList` cannot hold. An indented
    continuation comes back as a second paragraph and a backslash break splits the same way: no
    spelling survived the round trip (measured against `@tiptap/extension-list` 3.31.3). A
    construct only one side of the round trip can spell must not enter the dialect, so Shift-Enter
    starts a new to-do instead. The cost is that a reader cannot put a line break inside one to-do.
- **`@tiptap/extension-list` becomes an explicit dependency** at exactly the version starter-kit
  already resolves (`3.31.3`), so the import is not reaching into another package's transitive tree.
- **Keyboard.** Enter on a to-do with words makes a new to-do, and so does Shift-Enter; Tab nests a
  to-do under the one above, and Shift-Tab lifts it out. Enter on an empty nested to-do lifts it,
  Enter on an empty top-level to-do does nothing, and Backspace in an empty to-do removes it.
  - ⚠️ **Amended: this bullet said "all of it TaskItem's own", and that was wrong.** Left to
    `TaskItem`'s and the list keymap's own answers, Enter and Backspace on an empty to-do made lines
    that were not to-dos, and an Enter-then-Backspace in the middle of a list saved a body that
    reopened as two top-level lists. So the checklist binds these keys itself; a to-do holds one
    paragraph and at most one nested list; and a body holding more than one top-level list is
    joined into one as it loads.
- **Toolbar.** The marks, link, then **Outdent** and **Indent** (`liftListItem` / `sinkListItem`).
  No heading, list or quote buttons — they would do nothing in a document that can hold none of them.
- **A delete button on every row.** `TaskItem.extend({ addNodeView })` wraps the parent's node view
  (`this.parent?.()`) and appends one `contentEditable=false` button to its `dom`, visible on hover
  and on focus-within. It deletes the item **with its sub-to-dos** — a sub-to-do belongs to its
  parent — and deleting the only item leaves one empty one. Ctrl+Z brings it back; that is the
  editor's history and it is the only undo the list has (§5).
- **Accessible names.** `TaskItem`'s `a11y.checkboxLabel` names each checkbox after its text —
  "Mark "Revise tokens" done" / "Mark "Revise tokens" not done" — and the delete button is "Delete
  "Revise tokens"". As built, "its text" is the to-do's **own line**, never `node.textContent`,
  which runs a parent's sub-to-dos' words on after its own; the widget's rows are named the same way.
- **Appending on request.** The band's **New to-do** button must put the caret on a fresh item at the
  end. `NoteEditor` gains `appendRequest?: number` in checklist mode: when it changes, the editor
  appends an empty item (unless the last one is already empty) and focuses it. A counter rather than
  a boolean, so a second press is a second request.

### The dialect is Tiptap's own serialization, pinned by a round trip

The stored body is what `TaskItem.renderMarkdown` writes: `- [ ] text` / `- [x] text`, sub-to-dos
indented under their parent by `renderNestedMarkdownContent`. **The exact indent width is measured,
not assumed** — the first implementation task round-trips a committed corpus through the editor and
pins whatever the renderer emits, byte for byte, as `NoteEditor.test.tsx` already does for notes.
The reader in §5 compares indent *widths* against a stack rather than dividing by a constant, so it
holds whatever that measurement says.

**Measured on the build: two spaces per level, compounding** (`- [ ] a` / `  - [ ] b` /
`    - [ ] c` round-trips byte for byte, and four spaces in come back as two). An emptied list is
one empty item and serializes as `- [ ] `, with the trailing space; the band stores that as `""`
(§6).

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
  meant it about the deck. **That is where it parts from its twin**: `notes_open` is on no capture
  spec, so the Notes band's disclosure stays per device while the To-do band's follows the deck.
- ⚠️ **The honest cost of one-document storage: two devices editing the same deck's list while apart
  → the later write wins, whole.** Deck note bodies already behave exactly this way, and it is the
  price the reader chose, above, over a hand-built outliner.

### Everything else the rung owes

- `USER_SCHEMA_SQL`'s `decks` statement gains the two columns at its tail, **byte-identical** to what
  `ALTER TABLE … ADD COLUMN` writes into `sqlite_master` —
  `the_user_schema_is_byte_identical_to_what_the_ladder_builds` is the fence.
- `UNDO_V58` — `ALTER TABLE decks DROP COLUMN todos_open; ALTER TABLE decks DROP COLUMN todos;` — at
  the **front** of every rewind chain. `grep -c '{UNDO_V57}' schema.rs` counts them; do not trust a
  number written anywhere, this one included. **As built it drops the three `decks` capture
  triggers first**, `UNDO_V56`'s move: on a fixture that ran `capture::install`, `sync_ins_decks`
  and `sync_upd_decks` read `NEW.todos` and `NEW.todos_open`, and SQLite refuses a `DROP COLUMN` on
  a column a trigger reads.
- The hard-coded head assertions (`assert_eq!(…, 57)`) move to 58. `cargo test --lib schema::tests`
  finds the ones a list misses.
- `DeckRow` / `deck_row` gain `todos_open` (read the column index off `deck_row`, never off a doc),
  and `DeckPatch` gains it so the band's disclosure rides the existing deck update.
- **`todos` does not go on `DeckRow`.** Every deck list fetches `DeckRow`s; a body travels only
  through §5's two reads.
- **`duplicate_deck` does not copy `todos`.** A copy that carried its original's list would put every
  open to-do in the widget twice, and ticking one would leave its twin open. `todos_open` is not
  copied either; the copy starts collapsed.
- **Text mirror.** `decks` already maps to `DECKS_AND_COLLECTION` in `mirror::watch::surface_of`
  (a deck's name titles its group folder), so a to-do write marks both surfaces and costs one mirror
  pass that renders identical bytes — `deck_notes`' accepted cost, one table over. To-dos appear in
  no mirror file, export or share. A write whose body equals the stored one writes nothing, so it
  costs no pass at all (§5).
  - **Amended: this bullet said `DECKS_ONLY`**, which is what the tables of a deck's *contents* map
    to — `deck_cards`, `deck_notes` and the rest; the `decks` row itself has mapped to both surfaces
    all along.
- **Multi-window.** Nothing to register: `decks` is already on `userTables.json` and maps to the
  `["decks"]` key in `crossWindow.ts:131`, which is the prefix both of §5's query keys sit under.

---

## 5. The boundary

### Rust supplies facts — `src-tauri/src/deck_todos.rs`

Pure functions over `&Connection`, command wrappers in one `#[cfg(not(target_family = "wasm"))]`
block at the foot — `deck_notes.rs`'s shape. (As built the wrappers carry no `cfg` gate at all,
which is `sticky_notes.rs`' shape: that module has none.)

| Command | Answers |
| --- | --- |
| `deck_todos(deck_id)` | the body; `""` for a deck with no list **and for a deck that is not there** |
| `deck_todos_set(deck_id, body, expected?)` | `()` — see below |
| `deck_todo_lists()` | every deck whose `todos <> ''`: `{ deckId, name, archived, todosOpen, updatedAt, body }`, `updated_at DESC, id` — `todosOpen` so the widget's heading press writes the disclosure only when it is shut |

⚠️ **Amended: the read's row said "refuses `DECK_GONE`".** It answers `""` for an unknown deck,
`deck_notes::list_notes`' pure-read standing: the read that is *about* the deck is what reports it
gone, a band drawn for one has nothing to show either way, and the write is where a missing deck is
refused. Both reads are still **fallible** for any other failure, because a failed read that
answered `""` would mount an empty editor whose autosave wrote `""` over the reader's list.

**`deck_todos_set` is a compare-and-set when `expected` is given.** It reads the stored list and
writes in one transaction, so nothing lands between the comparison and the write, and it checks in
this order: a missing deck is `DECK_GONE` (first, so a stale tick against a deleted deck says the
deck went); a stored list that is not exactly `expected` is `TODOS_CHANGED`, and writes nothing; a
body equal to the stored one writes nothing at all — no `updated_at`, no capture op, no mirror pass;
otherwise `UPDATE decks SET todos = ?2, updated_at = unixepoch() WHERE id = ?1`. Both refusals are
`pub const` sentences, `deck_notes.rs`' convention. (This paragraph first drew it as one guarded
`UPDATE` read by its changed-row count; the build reads first, which is what lets the unchanged body
write nothing.)

- **The band writes without `expected`.** It is the author's surface and its autosave is the truth of
  what the reader typed.
- **The widget always sends `expected`** — the body it parsed. A tick is "flip the marker on line
  *n* of **this** text", and the text may have moved since: the band autosaving in another window, a
  sync apply. A refused tick refetches rather than guessing.

**What a write does beyond the column.** It bumps the deck's `updated_at`, in the same `UPDATE`, as
a deck note does, so a deck the reader just worked through reads as recently edited. It writes **no
`deck_audit` row, no `deck_undo` step and no `activity` row**: an autosave every 600 ms of typing
would flood the history panel with one line per pause, and the editor's own Ctrl+Z is the undo.
`sticky_notes.rs` made the same call for the same reason.

Registration: `lib.rs`' module map and `desktop.rs`' `generate_handler!`. **A miss is `unknown
command` at runtime with nothing red.** No capability entry — app commands take none. (Amended: this
line also named `web::route`'s `COMMANDS` and its `match` arm, and there is no web router in this
tree.)

### TypeScript draws conclusions — `src/features/decks/todoMarkdown.ts`

Pure, tested, no React.

- `parseTodos(body): TodoItem[]` — a tree. Each item: `done`, `inlines` (through `parseInlines`,
  which `noteMarkdown.ts` now exports), `text` (the plain words), `line` (0-based source line of
  its marker), `children`.
  - An item line is a bullet and then, optionally, a box — `^([ \t]*)[-*+](?:[ \t]+|$)(?:\[( |x|X)\](?:[ \t]+|$))?([\s\S]*)$`
    as built, where this said `^(\s*)[-*+] \[( |x|X)\](?: (.*))?$`. The box is optional so a plain
    bullet reads as a to-do with its words rather than with `- ` glued to the front. Depth comes
    from comparing indent widths against a stack, never from dividing by a constant (§3); a tab
    stops on the next multiple of four.
  - A non-blank line that is not an item is a **continuation** of the item above it when it is
    indented **deeper** than that item's marker, or when the line before it ended in a hard break —
    the second is how a break in a top-level to-do is written, with the rest of the line not
    indented at all. A continuation after a hard break is joined with `"\n"`; one that merely wraps
    is joined with a space, CommonMark's reading; one after a blank line is a second paragraph and
    joined with `"\n"`.
    - ⚠️ **Amended: this said a continuation is "indented at least as deep as the item above it"
      (`>=`).** Tiptap never writes that shape and CommonMark's lazy continuation is out of scope,
      so the build reads `>` or a hard break above. What that costs is that a foreign body's stray
      line at its item's own depth reads as a to-do of its own rather than as more of the one above
      — which the nothing-dropped rule below still shows. The editor writes no hard break at all
      now (§3), so the break arm exists for bodies written elsewhere.
  - **Nothing is dropped for not being understood** — `noteMarkdown.ts`' rule. Any other non-blank
    line reads as an open to-do with that text. No path writes such a line today; the rule exists so
    a body from a future build still shows every line. The one thing left out is an **empty** to-do
    with nothing under it — the editor's placeholder line; an emptied parent is kept for the
    sub-to-dos that hang from it. A to-do whose only text is `&nbsp;` reads as empty, as the
    editor's own reader reads it.
- `countTodos(items) → { open, done }` — every item counts, at every depth.
- `toggleTodo(body, line) → string | null` — flips exactly the marker on that line and touches no
  other byte, a trailing `\r` included; `null` if that line has no box to flip — a plain bullet,
  a stray line, and `- [x]glued`, which the reader draws as the text `[x]glued`.
- `todosText(body) → string` — the body as the band stores it: `""` when `parseTodos` finds no
  to-do, and otherwise the body byte for byte. An emptied checklist is one empty item in the
  editor, and stored as it stands it would keep a deck in the widget with nothing under it.
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

**Saving.** Autosave 600 ms after the last change, flushed when the caret leaves the editor and on
unmount — `StickyNoteDialog`'s behaviour and its constant. The caret is tracked on a wrapper around
the editor, toolbar and link field included, so moving it to **New to-do** or to the disclosure
counts as leaving and writes at once. The count in the header is computed from the draft, so it
moves as the reader ticks. What is stored is `todosText(draft)`, so an emptied checklist stores `""`.

- **Added in the build: saves run one at a time, in the order they were made.** `deck_todos_set`
  waits for the database's write lock and the wait is not fair, so two pauses 600 ms apart could
  land newer-first; the older text would then be cached last and adopted over the reader's newer
  words. The save mutation takes a TanStack `scope` per deck, and a queued save still reads as
  pending, which holds the band still while it waits.
- **Added in the build: a save cancels in-flight reads of its key before it caches its answer.** A
  background re-read that began before the write committed would otherwise land after
  `setQueryData` and put the old text back for an idle band to adopt. The cancel is in `onSuccess`,
  not the usual `onMutate`, because `onMutate` runs when a save is *queued* and misses every read
  that begins while it waits.
- **A refused save leaves the draft on screen and still owed**; the next change, blur or unmount
  tries again.

**Adopting a change from elsewhere.** The band's query (`["decks", "todos", deckId]`) refetches when
the widget ticks an item or another window writes. The editor takes the new body **only when it is
not focused, holds no unsaved edit and has no save pending or queued**, and takes it as a remount
seeded with it; otherwise the reader's typing wins and the next autosave overwrites. That is the
one-document cost of §4 stated at its sharpest, and it is deliberate: losing a tick made elsewhere is
recoverable at a glance, losing a sentence mid-type is not.

**A failed read mounts no editor** (added in the build). The editor is gated on the first read that
landed: a refused first read draws the band's alert line and no editor, because an empty editor's
first keystroke would autosave `""` over the reader's list; a refused refetch later keeps the editor
already open, since the query keeps its last good answer.

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
  - **Added in the build: `Include archived decks` holds under `Chosen…` too**, where `DecksWidget`
    and `deckCompletion` draw a chosen archived deck regardless — so the switch always means what
    its label says. The picker offers archived decks only while it is on, and keeps a choice it does
    not offer in the stored set.
- **It does not join `DEFAULT_LAYOUT`** — every kind since `newPrintings` has been catalogue-only, and
  the default layout is an exact 8×7 rectangle held in three copies.
- ⚠️ `widgets.test.ts` pins `WIDGETS.slice(-4)` to round two's four kinds, so appending this row
  moves that assertion; update it to name what it means rather than to a new count. (**As built,
  the row was not appended**: it sits between `stickyNotes` and `newPrintings`, beside the other
  kind a reader writes into, so the pin did not move.)

**The body.** One query, `["decks", "todos", "lists"]` over `deck_todo_lists`, filtered and ordered
in TS. Grouped by deck:

- A **deck heading** — the deck's name, and the open count when `counts` is on. Pressing it opens
  the deck **with its To-do band expanded**: `deck.update({ todosOpen: true })` when it is closed,
  then `setActiveView("decks")`, then `setOpenDeckId(id)` — the order `DeckCompletionWidget` pins.
  As built the disclosure write is awaited and then invalidates `["decks"]`, so the deck opens on
  it, and a refused write still opens the deck. It is an ordinary `deck_update`, so it moves the
  deck's `updated_at` and reorders `Last edited`.
- Under it, the to-dos from `visibleTodos`, sub-to-dos indented one step per level. The inline text
  renders through the widget's own `Inline` components with **`whitespace-pre-line`** (a hard break
  is a `"\n"` inside a run). **A link is drawn and never followed** (added in the build): the whole
  row is the checkbox press, and nothing pressable may sit inside a press.
- **The checkbox ticks in place**: `toggleTodo(body, line)` → `deck_todos_set(deckId, next, body)`.
  A success writes the new body into the cache at once, so a second tick's `expected` is the body
  the first one wrote. A refusal refetches and prints the refusal's own sentence —
  `TODOS_CHANGED` is "That to-do list changed since it was read. Try again." — in the widget's
  one-line failure slot.
  - **Amended: this said "the row greys while the write is in flight".** As built, **every** box
    refuses (`aria-disabled`) while any tick is out, because a second tick's `expected` would be
    the body the first is replacing; only the pressed row is drawn faint.
  - **Added in the build: a line with no box is drawn with a dashed, inert box.** §5's
    nothing-dropped rule reads a plain bullet as an open to-do, but `toggleTodo` answers `null` for
    it, so its row is `aria-disabled` and a press writes nothing.
- Decks with nothing visible (every to-do done and completed hidden) are left out. Rows are whole
  rows, and what does not fit is summarised by a `+N more` footer.
  - **Amended: the cut is not `fit.fitCount` over one row height.** Each row costs its own drawn
    height — a heading one line, a to-do its padding and one line per line its text is estimated to
    wrap to — and **the to-do the cut lands on is drawn clamped to the lines left**, so a to-do
    taller than the whole card still shows its first lines instead of an empty card and a footer.
    A heading whose to-dos all fell past the cut is dropped with them.

**The fences on `WidgetBodyProps`.** `still` (the catalogue preview): nothing ticks, nothing
navigates, the scroller clips. `editing` (Customize): the page makes the body inert, so a press is a
pick-up.

**Empty.** "No to-dos yet" and one dim line — "Add them in any deck's To-do band." A read failure is
`WidgetMessage`'s sentence.

- **Added in the build: three more sentences**, because "No to-dos yet" is false in each case. A
  `Chosen…` scope with nothing chosen says *No decks chosen. Choose decks in this widget's
  settings.* Decks in scope whose every to-do is done, with completed ones hidden, say *Every to-do
  here is done. Enable Show completed in settings to view them.* And with `Show sub-to-dos` off, a
  deck whose only open work is nested under finished to-dos draws nothing while something in it is
  still open, so that case says *Open to-dos are nested under finished ones. Enable Show sub-to-dos
  in settings to view them.* Both switch names are read off the registry row.

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
