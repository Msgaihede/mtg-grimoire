# Deck to-dos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A per-deck to-do checklist written in the notes' rich text editor, drawn as a band below the deck notes band, plus a home widget that gathers open to-dos across decks and ticks them off in place.

**Architecture:** Two new `decks` columns at user schema v58 (`todos` markdown, `todos_open` disclosure) that sync per field on the existing `decks` capture spec; a Rust module of three commands (a compare-and-set write among them); a pure TypeScript dialect module that parses and toggles the checklist markdown; a `checklist` mode on the lazy `NoteEditor` built from Tiptap's own `TaskList`/`TaskItem`; a `DeckTodosPanel` band that autosaves; and a `deckTodos` home widget.

**Tech Stack:** Rust (rusqlite, Tauri 2), React 19 + TypeScript 6, Tiptap 3.31.3 (`@tiptap/extension-list`), TanStack Query, Vitest, Storybook.

**Spec:** `docs/superpowers/specs/2026-09-29-deck-todos-design.md` — every task implements a section of it; read the section named in the task before starting.

## Global Constraints

- User schema rung **58** (`USER_SCHEMA_VERSION` is 57 on `main` today). Re-check with `grep -n "pub const USER_SCHEMA_VERSION" src-tauri/src/schema.rs` before landing; take the next free number at landing.
- Columns: `decks.todos TEXT NOT NULL DEFAULT ''`, `decks.todos_open INTEGER NOT NULL DEFAULT 0`. Both on the `decks` capture spec. Neither on `deck_undo::DECK_FIELDS`, neither copied by `duplicate_deck`, `todos` never on `DeckRow`.
- Commands (wire names): `deck_todos(deckId) -> string`, `deck_todos_set(deckId, body, expected: string | null) -> ()`, `deck_todo_lists() -> DeckTodoList[]`.
- Refusals: `deck_todos::TODOS_CHANGED = "That to-do list changed since it was read. Try again."`; a missing deck is `crate::deck::GONE`.
- No `deck_audit` row, no `deck_undo` step, no `activity` row for a to-do write.
- Query keys: band `["decks", "todos", deckId]`; widget `["decks", "todos", "lists"]` (exported as `deckTodoListsKey` from `src/features/home/keys.ts`).
- Words on screen: band heading **To-do**; widget label **To-dos**; placeholder *"Add a to-do — Enter for the next, Tab to nest."*; empty widget **No to-dos yet** / *"Add them in any deck's To-do band."*
- Autosave delay: reuse `600` ms (`StickyNoteDialog`'s `SAVE_DELAY_MS`); flush on blur and unmount.
- `NoteEditor` is reached **only** through `React.lazy`/`import()` — never a static import, not even of a constant from it (`DeckNotesPanel.test.tsx` sweeps for it).
- `@tiptap/extension-list` becomes an explicit dependency at `^3.31.3` (the repo's style for Tiptap).
- Never install `@types/node`; no Tailwind class built by interpolation; z-indexes only from `LAYER`; hints only via `useTooltip()`; `aria-disabled`, never `disabled`, on anything that greys while typing; no `setState` inside an effect body.
- **Subagents do not commit and do not run `npm run verify`.** The orchestrator stages each task's files and commits after fan-in, then runs `npm run verify` once. A subagent may run its own *targeted* test file(s) where named in its task.

## Review Focus

1. **A failed first read must never be autosaved over.** If `deck_todos` refuses (a sync holding the db, a busy write lock), the band must not mount an empty editor whose autosave then writes `""` over the reader's list. Pinned in Task 5 (the band renders a failure line and no editor when the read is not a success).
2. **An empty checklist is not a to-do.** A fresh editor serializes its one empty task item as `- [ ]`; stored, that would make a deck show up in the widget with a blank row. Pinned in Task 3 (`parseTodos` drops empty items) and Task 5 (the band stores `""` when `parseTodos` finds nothing).
3. **A tick against a moved list must not flip the wrong line.** The widget's compare-and-set is what makes a line number safe; pinned in Task 1 (`expected` mismatch refuses and writes nothing) and Task 6 (a refused tick refetches and says so).
4. **Nested items at whatever indent Tiptap emits.** The parser compares indent widths; pinned in Task 3 (2- and 4-space corpora, tabs) and Task 4 (the editor's own round trip, byte for byte, feeds `parseTodos`).
5. **Deleting a to-do deletes its sub-to-dos, and deleting the last one leaves one empty item** rather than an invalid document. Pinned in Task 4.

---

## File map

| Task | Creates | Modifies |
| --- | --- | --- |
| 1 Rust | `src-tauri/src/deck_todos.rs` | `src-tauri/src/schema.rs`, `src-tauri/src/sync_engine/capture.rs`, `src-tauri/src/deck.rs`, `src-tauri/src/mirror/layout.rs` (fixture), `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs` (or wherever `web::route`'s `COMMANDS` lives) |
| 2 TS mirror + fake | — | `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `.storybook/fake/db.ts`, `.storybook/fake/db.test.ts`, `.storybook/fake/seeds.ts` (if decks are seeded there), and the `DeckRow` fixture in every test/story file listed in Task 2 |
| 3 Dialect | `src/features/decks/todoMarkdown.ts`, `src/features/decks/todoMarkdown.test.ts` | `src/features/decks/noteMarkdown.ts` (exports only) |
| 4 Editor | — | `src/features/decks/NoteEditor.tsx`, `src/features/decks/NoteEditor.test.tsx`, `package.json`, `package-lock.json` |
| 5 Band | `src/features/decks/DeckTodosPanel.tsx`, `DeckTodosPanel.test.tsx`, `DeckTodosPanel.stories.tsx`, `useDeckTodos.ts` | `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckEditor.test.tsx` |
| 6 Widget | `src/features/home/widgets/DeckTodosWidget.tsx`, `.test.tsx`, `.stories.tsx` | `src/features/home/widgets.ts`, `widgets.test.ts`, `HomePage.tsx`, `HomePage.test.tsx`, `keys.ts`, `keys.test.tsx` |
| 7 Docs | — | `docs/reference/decks-storage.md`, `docs/reference/home-page.md`, `docs/reference/data-and-sync.md` (schema ladder row), `src/features/decks/CLAUDE.md`, root `CLAUDE.md` (one sentence) |

Tasks 1–6 touch disjoint files and run in parallel. Task 7 runs after fan-in so it describes the code as built.

---

### Task 1: Rust — schema v58, the `decks` plumbing, and `deck_todos.rs`

**Read first:** spec §4 and §5. Template for every column site: `git grep -n "curve_creatures"` — user schema v56 added one `decks` column and every place it touched is a place `todos_open` touches. `notes_open` (v43) is the disclosure precedent. `src-tauri/src/sticky_notes.rs` and `deck_notes.rs` are the module-shape precedents (pure functions over `&Connection` first, command wrappers in one `#[cfg(not(target_family = "wasm"))]`-style block at the foot — copy whatever gating `sticky_notes.rs` uses).

**Files:**
- Create: `src-tauri/src/deck_todos.rs`
- Modify: `src-tauri/src/schema.rs` (rung, `USER_SCHEMA_SQL`'s `decks` line ~4132, `UNDO_V58` + every chain, head assertions, index/object counts if they move)
- Modify: `src-tauri/src/sync_engine/capture.rs` (the `decks` spec's `fields`, ~line 430–500)
- Modify: `src-tauri/src/deck.rs` (`DeckPatch` ~663, `DeckRow` ~979, `DECK_SELECT` ~1334, `deck_row` ~1475–1485, `update_deck`'s SQL ~2491–2527, the JSON/serde tests ~11293–11490, a duplicate test)
- Modify: `src-tauri/src/mirror/layout.rs:649` (a `DeckRow` literal in a test)
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs`, the web router (`grep -rn "sticky_note_reorder" src-tauri/src` finds all three registration sites)

**Interfaces:**
- Produces (wire, serde camelCase): `DeckRow.todos_open: bool` → `todosOpen`; `DeckPatch.todos_open: Option<bool>` → `todosOpen`; `DeckTodoList { deck_id, name, archived, todos_open, updated_at, body }` → `{ deckId, name, archived, todosOpen, updatedAt, body }`; commands `deck_todos(deck_id: i64) -> Result<String, String>`, `deck_todos_set(deck_id: i64, body: String, expected: Option<String>) -> Result<(), String>`, `deck_todo_lists() -> Result<Vec<DeckTodoList>, String>`; `pub const TODOS_CHANGED: &str`.

- [ ] **Step 1: The rung.** In `migrate_user`, after the `if v < 57` block and before the "clock repaired every launch" block, add (comment in the file's voice: v56's rules hold — `ADD COLUMN`, on the `decks` capture spec, no history row, no undo list, not carried by `duplicate_deck`; `todos_open` is `notes_open`'s twin and `DEFAULT 0` for v43's reason; `todos` is the checklist in the dialect `todoMarkdown.ts` reads, spec 2026-09-29):

```rust
    if v < 58 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "ALTER TABLE decks ADD COLUMN todos TEXT NOT NULL DEFAULT '';
             ALTER TABLE decks ADD COLUMN todos_open INTEGER NOT NULL DEFAULT 0;",
        )?;
        // Literal `58`, for the reason every step before it writes its own.
        tx.execute_batch("PRAGMA main.user_version = 58;")?;
        tx.commit()?;
    }
```

Set `USER_SCHEMA_VERSION` to 58.

- [ ] **Step 2: `USER_SCHEMA_SQL`.** Append to the `decks` CREATE line, before its closing `);`, exactly what `ALTER TABLE … ADD COLUMN` writes into `sqlite_master`: `, todos TEXT NOT NULL DEFAULT '', todos_open INTEGER NOT NULL DEFAULT 0`. The fence is `the_user_schema_is_byte_identical_to_what_the_ladder_builds`.

- [ ] **Step 3: `UNDO_V58`** beside `UNDO_V57`, with a doc comment in the same voice (owed for `UNDO_V13`'s loud reason; the three capture triggers come off first because SQLite refuses `DROP COLUMN` on a column a trigger names):

```rust
    const UNDO_V58: &str = "DROP TRIGGER IF EXISTS sync_ins_decks;
         DROP TRIGGER IF EXISTS sync_upd_decks;
         DROP TRIGGER IF EXISTS sync_del_decks;
         ALTER TABLE decks DROP COLUMN todos_open;
         ALTER TABLE decks DROP COLUMN todos;";
```

Prepend `{UNDO_V58}` to **every** chain that starts with `{UNDO_V57}`: `grep -c '{UNDO_V57}' src-tauri/src/schema.rs` before and after — every hit must become a `{UNDO_V58}{UNDO_V57}` (or the chain's own separator). Bump every hard-coded head assertion (`assert_eq!(USER_SCHEMA_VERSION, 57)` and the `assert_eq!(version|v, 57)` lines); `cargo test --lib schema::tests` finds the ones you miss.

- [ ] **Step 4: Capture.** Add `"todos"` and `"todos_open"` to the `decks` spec's `fields` in `capture.rs`, after `managed_wishlist_tokens`, with a comment: `todos` is the reader's checklist and travels per field (a to-do edit on one device and a rename on another both survive); `todos_open` travels for `tokens_open`'s reason; both `DEFAULT` safely for an old peer (adding is the safe direction). Extend the existing `decks` capture test near `capture.rs:1444` (the one that asserts `curve_creatures` rides an update) with `UPDATE decks SET todos = '- [ ] a' WHERE id = 1` asserting `fields.get("todos")`.

- [ ] **Step 5: `DeckRow` / `DeckPatch` / `update_deck`.** `DeckPatch` gains `pub todos_open: Option<bool>` (doc: the To-do band's disclosure, user schema v58, a reading preference like `notes_open`). `DeckRow` gains `pub todos_open: bool`. `DECK_SELECT` appends `, d.todos_open` after `d.managed_wishlist_tokens`; `deck_row` reads it at index **32** with a comment in the style of 30/31 (a `bool` over an `INTEGER`; the silent trap is `notes_open` at 26 — a crossed index opens the wrong band). `update_deck`'s SQL gains `todos_open = coalesce(?26, todos_open),` after `managed_wishlist_tokens` and `patch.todos_open` at the end of `params!`. **Do not** add `todos` to `DeckRow`, `DECK_SELECT` or `DeckPatch`. Update every `DeckRow { … }` / `DeckPatch { … }` literal and JSON fixture the compiler or the serde tests name (deck.rs ~11293–11490, `mirror/layout.rs:649`). Confirm `todos_open` is **not** added to `deck_undo::DECK_FIELDS` and add a one-line comment beside `curve_creatures`' absence note there (`deck_undo.rs:133`) saying v58's two columns are absent on the same terms.

- [ ] **Step 6: Write the failing module tests.** Create `src-tauri/src/deck_todos.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> Connection {
        let conn = crate::schema::memory_pair();
        conn.execute_batch(
            "INSERT INTO decks (id, name, format_key, archived, created_at, updated_at)
             VALUES (1, 'Burn', 'modern', 0, 0, 0),
                    (2, 'Zoo', 'modern', 1, 0, 5),
                    (3, 'Empty', 'modern', 0, 0, 9);",
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_new_deck_has_an_empty_list_and_an_unknown_deck_reads_empty() {
        let conn = db();
        assert_eq!(read_todos(&conn, 1).unwrap(), "");
        assert_eq!(read_todos(&conn, 404).unwrap(), "");
    }

    #[test]
    fn a_write_is_read_back_and_moves_updated_at() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] Revise tokens", None).unwrap();
        assert_eq!(read_todos(&conn, 1).unwrap(), "- [ ] Revise tokens");
        let at: i64 = conn
            .query_row("SELECT updated_at FROM decks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert!(at > 0, "the write touches the deck");
    }

    #[test]
    fn a_matching_expected_writes_and_a_moved_one_refuses_and_writes_nothing() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        set_todos(&conn, 1, "- [x] a", Some("- [ ] a")).unwrap();
        assert_eq!(read_todos(&conn, 1).unwrap(), "- [x] a");
        assert_eq!(
            set_todos(&conn, 1, "- [ ] a", Some("- [ ] a")).unwrap_err(),
            TODOS_CHANGED
        );
        assert_eq!(read_todos(&conn, 1).unwrap(), "- [x] a", "a refusal writes nothing");
    }

    #[test]
    fn a_write_to_a_deck_that_is_not_there_is_gone() {
        let conn = db();
        assert_eq!(set_todos(&conn, 404, "- [ ] a", None).unwrap_err(), crate::deck::GONE);
    }

    #[test]
    fn an_unchanged_body_writes_nothing() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        conn.execute("UPDATE decks SET updated_at = 0 WHERE id = 1", []).unwrap();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        let at: i64 = conn
            .query_row("SELECT updated_at FROM decks WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(at, 0, "a write that changes nothing does not touch the deck");
    }

    #[test]
    fn the_lists_leave_empty_ones_out_and_read_newest_first() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] one", None).unwrap();
        set_todos(&conn, 2, "- [ ] two", None).unwrap();
        conn.execute("UPDATE decks SET updated_at = 10 WHERE id = 1", []).unwrap();
        conn.execute("UPDATE decks SET updated_at = 20, todos_open = 1 WHERE id = 2", []).unwrap();
        let lists = list_lists(&conn).unwrap();
        let ids: Vec<i64> = lists.iter().map(|l| l.deck_id).collect();
        assert_eq!(ids, vec![2, 1], "newest first; deck 3 has no list");
        assert!(lists[0].archived && lists[0].todos_open);
        assert_eq!(lists[0].body, "- [ ] two");
        assert_eq!(lists[0].name, "Zoo");
    }

    #[test]
    fn a_duplicate_carries_neither_column() {
        let conn = db();
        set_todos(&conn, 1, "- [ ] a", None).unwrap();
        conn.execute("UPDATE decks SET todos_open = 1 WHERE id = 1", []).unwrap();
        let copy = crate::deck::duplicate_deck(&conn, 1).unwrap();
        assert_eq!(read_todos(&conn, copy.id).unwrap(), "");
        assert!(!copy.todos_open);
    }
}
```

(If `duplicate_deck` needs categories or a corpus row the bare insert lacks, seed the deck the way `deck_meta.rs`'s `duplicate_deck_copies_both_lists_piles_and_remaps_onto_them` does. If `memory_pair` is not the name, use whatever `sticky_notes.rs`' `db()` calls.)

- [ ] **Step 7: Run to see them fail.** Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib deck_todos` — Expected: compile error (module not declared / functions missing). Add `pub mod deck_todos;` to `lib.rs`'s module map so the tests are actually compiled (an undeclared module makes every cargo run vacuous).

- [ ] **Step 8: Implement.** Above the tests, with a module doc in the house voice (spec §5: one list per deck, two columns rather than a table, no audit/undo/activity and why, the compare-and-set and why the widget needs it):

```rust
use crate::sync::{with_write, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::Arc;

/// What a compare-and-set write says when the stored list is no longer the one the caller read.
pub const TODOS_CHANGED: &str = "That to-do list changed since it was read. Try again.";

/// One deck's list, as the home widget reads it.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckTodoList {
    pub deck_id: i64,
    pub name: String,
    pub archived: bool,
    pub todos_open: bool,
    pub updated_at: i64,
    /// The checklist, in the dialect `todoMarkdown.ts` reads. Never empty here.
    pub body: String,
}

/// The deck's checklist. A pure read: an unknown deck answers `""`, `deck_notes::list_notes`' standing.
pub fn read_todos(conn: &Connection, deck_id: i64) -> Result<String, String> {
    conn.query_row("SELECT todos FROM decks WHERE id = ?1", params![deck_id], |r| r.get(0))
        .optional()
        .map(|found| found.unwrap_or_default())
        .map_err(|e| e.to_string())
}

/// Write the checklist. With `expected`, a compare-and-set: refused with [`TODOS_CHANGED`] unless the
/// stored list is exactly `expected`. A body equal to the stored one writes nothing at all.
pub fn set_todos(
    conn: &Connection,
    deck_id: i64,
    body: &str,
    expected: Option<&str>,
) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let current: Option<String> = tx
        .query_row("SELECT todos FROM decks WHERE id = ?1", params![deck_id], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(current) = current else {
        return Err(crate::deck::GONE.to_owned());
    };
    if expected.is_some_and(|e| e != current) {
        return Err(TODOS_CHANGED.to_owned());
    }
    if current == body {
        return Ok(());
    }
    tx.execute(
        "UPDATE decks SET todos = ?2, updated_at = unixepoch() WHERE id = ?1",
        params![deck_id, body],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// Every deck with a non-empty list, most recently edited first.
pub fn list_lists(conn: &Connection) -> Result<Vec<DeckTodoList>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, archived, todos_open, updated_at, todos FROM decks
              WHERE todos <> '' ORDER BY updated_at DESC, id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(DeckTodoList {
                deck_id: r.get(0)?,
                name: r.get(1)?,
                archived: r.get::<_, i64>(2)? != 0,
                todos_open: r.get::<_, i64>(3)? != 0,
                updated_at: r.get(4)?,
                body: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())
}
```

Commands at the foot, gated exactly as `sticky_notes.rs` gates its wrappers. **Both reads are fallible, not `unwrap_or_default`** — a read that failed and answered `""` would let the band autosave an empty list over the reader's (Review Focus 1):

```rust
fn unfinished(e: tauri::Error) -> String {
    format!("the to-do list could not be written: {e}")
}

#[tauri::command(async)]
pub fn deck_todos(state: tauri::State<'_, Arc<AppState>>, deck_id: i64) -> Result<String, String> {
    read_todos(&crate::sync::lock_db_read(state.inner()), deck_id)
}

#[tauri::command]
pub async fn deck_todos_set(
    state: tauri::State<'_, Arc<AppState>>,
    deck_id: i64,
    body: String,
    expected: Option<String>,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_todos(c, deck_id, &body, expected.as_deref()))
    })
    .await
    .map_err(unfinished)?
}

#[tauri::command(async)]
pub fn deck_todo_lists(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<DeckTodoList>, String> {
    list_lists(&crate::sync::lock_db_read(state.inner()))
}
```

(Check `with_write`'s closure signature against `sticky_notes.rs` and match it.)

- [ ] **Step 9: Register.** `desktop.rs`' `generate_handler!` (beside the sticky-note five: `deck_todos::deck_todos, deck_todos::deck_todos_set, deck_todos::deck_todo_lists`), and the web router's `COMMANDS` array **plus** its `match` arms (copy `sticky_notes`' arms; all three are connection-only). No capability entry.

- [ ] **Step 10: Run.** `cargo test --manifest-path src-tauri/Cargo.toml --lib deck_todos` then `cargo test --manifest-path src-tauri/Cargo.toml --lib schema::tests` then `cargo test --manifest-path src-tauri/Cargo.toml --lib capture` then `cargo test --manifest-path src-tauri/Cargo.toml --lib deck::` — Expected: PASS. Then `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings` and `cargo fmt --manifest-path src-tauri/Cargo.toml`. You are the only task running cargo; do not run `npm run verify`.

- [ ] **Step 11: Report** the files changed, the final `grep -c '{UNDO_V58}'` count, and any object/index count you re-counted. Do not commit.

---

### Task 2: TypeScript mirror, the Storybook fake, and every `DeckRow` fixture

**Read first:** `src/CLAUDE.md` (the `ipc.ts` mirror paragraph), `.storybook/CLAUDE.md`. Precedent: `git grep -n "curveCreatures"` — every site it touches outside `src-tauri/` is a site `todosOpen` touches, except `DeckStats*` and `ManaCurveChart*` (chart props, not the row).

**Files:**
- Modify: `src/lib/ipc.ts` (`DeckPatch` ~3657, `DeckRow` ~4077, a new `DeckTodoList` type beside `DeckNote` ~4883, three wrappers beside `deckNote*` ~8576)
- Modify: `src/lib/ipc.test.ts` (struct-table rows for `DeckRow`/`DeckPatch` already exist — they will go red until the field is mirrored; add a row for `DeckTodoList` against `deck_todos.rs`, add command/argument cases for the three commands in the style of the sticky-note cases ~3379–3461, and a `deckUpdate(…, { todosOpen: true })` case beside the `curveCreatures` one ~1009)
- Modify: `.storybook/fake/db.ts` (the fake deck type ~734, its reader ~7609, deck creation ~18856, `deck_update`'s patch ~19288, and three new handlers in `allHandlers`), `.storybook/fake/db.test.ts`
- Modify (add `todosOpen: false` to each `DeckRow` literal): `src/App.test.tsx`, `src/components/menu/ContextMenu.stories.tsx`, `src/features/card/cardMenu.test.tsx`, `src/features/collection/CollectionPage.test.tsx`, `src/features/decks/CategoriesDialog.test.tsx`, `CreateDeckDialog.test.tsx`, `DeckSettingsDialog.test.tsx`, `DecksPage.test.tsx`, `deckBuckets.test.ts`, `deckFilter.test.ts`, `deckMenu.test.tsx`, `deckSort.test.ts`, `useDeck.test.ts`, `useDecks.test.ts`, `src/features/home/widgets/DeckCompletionWidget.test.tsx`, `DecksWidget.test.tsx`, `NewPrintingsWidget.test.tsx`, `SummaryWidget.test.tsx`, `src/features/transfer/import/ImportDialog.test.tsx`, `destinations/DeckPreview.test.tsx`, `useImport.test.ts`, plus any other file `tsc` names. **Not** `DeckEditor.test.tsx` (Task 5 owns it).

**Interfaces:**
- Consumes: Task 1's wire shapes (Global Constraints).
- Produces: `DeckRow.todosOpen: boolean`; `DeckPatch.todosOpen?: boolean`; `export interface DeckTodoList { deckId: number; name: string; archived: boolean; todosOpen: boolean; updatedAt: number; body: string }`; `ipc.deckTodos(deckId: number): Promise<string>`; `ipc.deckTodosSet(deckId: number, body: string, expected: string | null): Promise<void>`; `ipc.deckTodoLists(): Promise<DeckTodoList[]>`. Fake: `.storybook/fake/db.ts` exports nothing new but its deck rows carry `todos: string` and `todosOpen: boolean` (fake-internal), and a seeded deck or two carry a small checklist so the stories in Tasks 5 and 6 have data.

- [ ] **Step 1: Mirror.** Add the fields and type with doc comments in the file's voice (why `todos` is not on `DeckRow`: every deck list fetches rows and a body travels only through the two reads). Wrappers:

```ts
  /**
   * One deck's to-do checklist, in `todoMarkdown.ts`' dialect. `""` for a deck with none — and for
   * a deck that is not there, which the band draws the same way. **Refuses rather than answering
   * `""` when the read fails**, because the band autosaves and must never save over a list it could
   * not read.
   */
  deckTodos: (deckId: number): Promise<string> => invoke("deck_todos", { deckId }),
  /**
   * Write one deck's checklist. `expected` is a compare-and-set: the widget passes the body it read
   * and a moved list is refused with `deck_todos::TODOS_CHANGED`; the band passes `null`.
   */
  deckTodosSet: (deckId: number, body: string, expected: string | null): Promise<void> =>
    invoke("deck_todos_set", { deckId, body, expected }),
  /** Every deck with a non-empty checklist, most recently edited first. */
  deckTodoLists: (): Promise<DeckTodoList[]> => invoke("deck_todo_lists"),
```

- [ ] **Step 2: `ipc.test.ts`.** Add the struct row and the three command cases (`commandParams(rs, cmd)` against `deck_todos.rs?raw`, `expect(desktopRs).toContain("deck_todos::deck_todos_set")` etc.). Run `npx vitest run src/lib/ipc.test.ts` — Expected: FAIL only if Task 1 has not landed the `.rs` file yet; that is expected mid-fan-out. Do not chase it.

- [ ] **Step 3: Fake.** Mirror the three commands in `.storybook/fake/db.ts`'s `allHandlers`: `deck_todos` returns the fake deck's `todos ?? ""`; `deck_todos_set` refuses `"That deck is not there any more."` for an unknown id, refuses `"That to-do list changed since it was read. Try again."` when `expected !== null && expected !== stored`, else stores and bumps `updatedAt`; `deck_todo_lists` returns non-empty lists sorted `updatedAt` desc. `deck_update` applies `patch.todosOpen ?? deck.todosOpen`; a new deck is born `todosOpen: false, todos: ""`. Seed two decks with checklists like:

```
- [ ] Revise tokens
  - [ ] Add a Treasure maker
  - [x] Cut Clue tokens
- [x] Sleeve the deck
```
and `- [ ] Cut three creatures`. Add `db.test.ts` cases for the compare-and-set refusal and the lists' order.

- [ ] **Step 4: Fixtures.** Add `todosOpen: false` to every `DeckRow` literal in the files listed above. Find stragglers with `npx tsc --noEmit -p tsconfig.json` (it will also report errors from sibling tasks' in-flight files — only fix `DeckRow`/`todosOpen` errors in files you own).

- [ ] **Step 5: Run** `npx vitest run .storybook/fake/db.test.ts` — Expected: PASS. Report files changed. Do not commit.

---

### Task 3: The dialect — `todoMarkdown.ts`

**Read first:** spec §3 (the dialect) and §5 (TypeScript draws conclusions); `src/features/decks/noteMarkdown.ts` header and `parseInlines`.

**Files:**
- Modify: `src/features/decks/noteMarkdown.ts` — `export` `parseInlines`, `inlineText` and `HARD_BREAK` (no behaviour change; add one line to each doc saying `todoMarkdown.ts` reads it too)
- Create: `src/features/decks/todoMarkdown.ts`, `src/features/decks/todoMarkdown.test.ts`

**Interfaces:**
- Produces:
  - `export interface TodoItem { done: boolean; inlines: Inline[]; text: string; line: number; children: TodoItem[] }` — `line` is the 0-based source line of the item's marker; `text` is the plain text (`inlineText`).
  - `export function parseTodos(body: string): TodoItem[]`
  - `export function countTodos(items: TodoItem[]): { open: number; done: number }`
  - `export function toggleTodo(body: string, line: number): string | null`
  - `export function visibleTodos(items: TodoItem[], opts: { showDone: boolean; nested: boolean }): TodoItem[]`
  - `export function todosText(body: string): string` — the body normalised for storage: `""` when `parseTodos` finds no item, else `body` unchanged.

- [ ] **Step 1: Write the failing tests** (`todoMarkdown.test.ts`), covering at least:

```ts
import { describe, expect, it } from "vitest";
import { countTodos, parseTodos, todosText, toggleTodo, visibleTodos } from "./todoMarkdown";

const TWO = "- [ ] Revise tokens\n  - [ ] Add a Treasure maker\n  - [x] Cut Clue tokens\n- [x] Sleeve the deck";
const FOUR = "- [ ] Revise tokens\n    - [ ] Add a Treasure maker\n        - [x] Deeper\n- [ ] Next";

describe("parseTodos", () => {
  it("reads a flat list", () => {
    const items = parseTodos("- [ ] a\n- [x] b");
    expect(items.map((i) => [i.text, i.done, i.line])).toEqual([["a", false, 0], ["b", true, 1]]);
  });
  it("nests at two spaces", () => {
    const [top, last] = parseTodos(TWO);
    expect(top.children.map((c) => c.text)).toEqual(["Add a Treasure maker", "Cut Clue tokens"]);
    expect(last.text).toBe("Sleeve the deck");
  });
  it("nests at four spaces, three deep", () => {
    const [top, next] = parseTodos(FOUR);
    expect(top.children[0].children[0]).toMatchObject({ text: "Deeper", done: true, line: 2 });
    expect(next.text).toBe("Next");
  });
  it("reads a tab as indentation", () => {
    expect(parseTodos("- [ ] a\n\t- [ ] b")[0].children[0].text).toBe("b");
  });
  it("accepts X and the other bullets", () => {
    expect(parseTodos("* [X] a\n+ [ ] b").map((i) => i.done)).toEqual([true, false]);
  });
  it("reads inline marks", () => {
    expect(parseTodos("- [ ] cut **three** creatures")[0].inlines).toContainEqual({ kind: "strong", text: "three" });
  });
  it("joins a hard-broken continuation into the item", () => {
    const [item] = parseTodos("- [ ] first  \n      second\n- [ ] next");
    expect(item.text).toBe("first\nsecond");
    expect(parseTodos("- [ ] first  \n      second\n- [ ] next")).toHaveLength(2);
  });
  it("drops an empty item — an empty line in the checklist is not a to-do", () => {
    expect(parseTodos("- [ ] ")).toEqual([]);
    expect(parseTodos("- [ ] a\n- [ ] \n- [ ] b").map((i) => i.text)).toEqual(["a", "b"]);
  });
  it("keeps an empty item that has children", () => {
    const [item] = parseTodos("- [ ] \n  - [ ] child");
    expect(item.children[0].text).toBe("child");
  });
  it("reads a line it does not understand as an open to-do — nothing is dropped", () => {
    expect(parseTodos("just words").map((i) => [i.text, i.done])).toEqual([["just words", false]]);
    expect(parseTodos("- plain bullet")[0]).toMatchObject({ text: "plain bullet", done: false });
  });
  it("ignores blank lines and CRLF", () => {
    expect(parseTodos("- [ ] a\r\n\r\n- [ ] b").map((i) => i.text)).toEqual(["a", "b"]);
  });
});

describe("countTodos", () => {
  it("counts every depth", () => {
    expect(countTodos(parseTodos(TWO))).toEqual({ open: 2, done: 2 });
  });
});

describe("toggleTodo", () => {
  it("flips exactly one marker and touches no other byte", () => {
    const next = toggleTodo(TWO, 2)!;
    expect(next).toBe(TWO.replace("  - [x] Cut", "  - [ ] Cut"));
    expect(toggleTodo(next, 0)).toBe(next.replace("- [ ] Revise", "- [x] Revise"));
  });
  it("preserves CRLF", () => {
    expect(toggleTodo("- [ ] a\r\n- [ ] b", 1)).toBe("- [ ] a\r\n- [x] b");
  });
  it("answers null for a line with no checkbox", () => {
    expect(toggleTodo("- plain\n- [ ] a", 0)).toBeNull();
    expect(toggleTodo("- [ ] a", 9)).toBeNull();
  });
});

describe("visibleTodos", () => {
  const items = parseTodos("- [x] done parent\n  - [ ] open child\n- [x] done alone\n- [ ] open");
  it("hides a done item with nothing open under it, and keeps a done parent of an open child", () => {
    const shown = visibleTodos(items, { showDone: false, nested: true });
    expect(shown.map((i) => i.text)).toEqual(["done parent", "open"]);
    expect(shown[0].children.map((i) => i.text)).toEqual(["open child"]);
  });
  it("shows everything with completed on", () => {
    expect(visibleTodos(items, { showDone: true, nested: true })).toHaveLength(3);
  });
  it("shows only the top level with sub-to-dos off", () => {
    const shown = visibleTodos(items, { showDone: true, nested: false });
    expect(shown.every((i) => i.children.length === 0)).toBe(true);
  });
});

describe("todosText", () => {
  it("stores an empty checklist as nothing", () => {
    expect(todosText("- [ ] ")).toBe("");
    expect(todosText("")).toBe("");
    expect(todosText("- [ ] a")).toBe("- [ ] a");
  });
});
```

- [ ] **Step 2: Run** `npx vitest run src/features/decks/todoMarkdown.test.ts` — Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `todoMarkdown.ts` with a file header in the house voice (what the dialect is, that it is Tiptap's own serialization pinned by `NoteEditor.test.tsx`'s checklist corpus, that depth is compared by width, the nothing-dropped rule). Core:

```ts
import { HARD_BREAK, inlineText, parseInlines, type Inline } from "./noteMarkdown";

export interface TodoItem {
  done: boolean;
  inlines: Inline[];
  text: string;
  line: number;
  children: TodoItem[];
}

/** A bullet, optionally a `[ ]`/`[x]` box, then the item's text. Group 1 indent, 2 box, 3 text. */
const ITEM = /^([ \t]*)[-*+](?:[ \t]+|$)(?:\[( |x|X)\](?:[ \t]+|$))?(.*)$/;
/** The same line, box required — the only lines {@link toggleTodo} will touch. */
const BOXED = /^([ \t]*[-*+][ \t]+\[)( |x|X)(\].*)$/;
const TAB_STOP = 4;

function width(indent: string): number {
  let w = 0;
  for (const ch of indent) w = ch === "\t" ? w + TAB_STOP - (w % TAB_STOP) : w + 1;
  return w;
}

interface Draft { done: boolean; lines: string[]; line: number; children: Draft[] }

export function parseTodos(body: string): TodoItem[] {
  const roots: Draft[] = [];
  const stack: { indent: number; item: Draft }[] = [];
  let lastBroke = false;
  body.split("\n").forEach((raw, line) => {
    const src = raw.replace(/\r$/, "");
    if (src.trim() === "") { lastBroke = false; return; }
    const lead = /^[ \t]*/.exec(src)![0];
    const indent = width(lead);
    const m = ITEM.exec(src);
    const top = stack.at(-1);
    if (!m && top && (indent > top.indent || lastBroke)) {
      top.item.lines.push(src.trim());
    } else {
      const item: Draft = {
        done: m ? m[2] !== undefined && m[2] !== " " : false,
        lines: [m ? m[3] : src.trim()],
        line,
        children: [],
      };
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      (stack.at(-1)?.item.children ?? roots).push(item);
      stack.push({ indent, item });
    }
    lastBroke = HARD_BREAK.test(src);
  });
  return finish(roots);
}

function finish(drafts: Draft[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const d of drafts) {
    const children = finish(d.children);
    const inlines: Inline[] = [];
    d.lines.forEach((l, i) => {
      if (i > 0) inlines.push({ kind: "text", text: "\n" });
      inlines.push(...parseInlines(l.replace(HARD_BREAK, "")));
    });
    const text = inlineText(inlines);
    if (text.trim() === "" && children.length === 0) continue;
    out.push({ done: d.done, inlines, text, line: d.line, children });
  }
  return out;
}
```

Implement `countTodos` (recursive), `toggleTodo` (split on `"\n"`, match `BOXED` against the line with any trailing `\r` kept outside the match, flip `" "`→`"x"` and `x|X`→`" "`, rejoin with `"\n"`; `null` when the line is out of range or not boxed), `visibleTodos` (the recursive filter in spec §5: with `nested: false` children are dropped; a done item survives only when it has a visible child and `showDone` is off), `todosText`. If `pushText` merges adjacent text runs, make sure the `"\n"` run is not swallowed — adjust by pushing through `parseInlines`' own conventions or by concatenating text runs deliberately; the test for the hard break pins it.

- [ ] **Step 4: Run** `npx vitest run src/features/decks/todoMarkdown.test.ts src/features/decks/noteMarkdown.test.ts` — Expected: PASS. Report. Do not commit.

---

### Task 4: `NoteEditor`'s checklist mode

**Read first:** spec §3; `src/features/decks/NoteEditor.tsx` whole (the module header's dialect argument, `NOTE_EXTENSIONS`, `PROSE`, `SURFACE`, the toolbar ~501–587, the component ~393); `NoteEditor.test.tsx` (the committed round-trip corpus and the CSP sweep); `node_modules/@tiptap/extension-list/src/task-item/task-item.ts` and `task-list/task-list.ts`; memories *Prove a Tailwind variant by compiling it* and *A Tailwind arbitrary value can emit nothing*. Invoke the `frontend-design` skill before styling.

**Files:**
- Modify: `src/features/decks/NoteEditor.tsx`, `src/features/decks/NoteEditor.test.tsx`, `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: nothing from sibling tasks at build time. At test time the round-trip corpus is also fed to Task 3's `parseTodos` (import it in the test; it lands at fan-in).
- Produces: `NoteEditor` default export gains three optional props — `mode?: "note" | "checklist"` (default `"note"`, every existing caller unchanged), `appendRequest?: number`, `onAppendHandled?: () => void`. `export const TODO_PLACEHOLDER = "Add a to-do — Enter for the next, Tab to nest."`. (Exported from the lazy module like `NOTE_PLACEHOLDER`; callers may only reach it through `import()`.)

- [ ] **Step 1: Dependency.** `npm install @tiptap/extension-list@^3.31.3` — confirm `package.json` lists it beside the other `@tiptap/*` at `^3.31.3` and the lockfile resolves `3.31.3` (the same copy starter-kit already uses; `npm ls @tiptap/extension-list` shows one version).

- [ ] **Step 2: Write the failing tests** in `NoteEditor.test.tsx`, following the file's existing harness for mounting the editor and reading its markdown:
  - **Round trip, byte for byte**, over a committed checklist corpus: a flat list, a checked item, a two-deep and a three-deep nest, bold/italic/strike/code/link inside an item, a hard break inside an item. **First run it to learn what the serializer emits for nesting and hard breaks** (Review Focus 4): write each corpus entry in Tiptap's own output shape, and record the indent width in a comment beside the corpus. Also assert `parseTodos(body)` reads the expected tree for each entry (import from `./todoMarkdown`).
  - `mode="checklist"` renders `ul[data-type="taskList"]` and a checkbox per item, each named `Mark "<text>" done` / `Mark "<text>" not done`.
  - Clicking a checkbox calls `onChange` with the `[x]` markdown.
  - Enter at the end of an item produces a second `- [ ]` line; Tab nests it; Shift-Tab lifts it (drive with the editor's commands if jsdom keyboard dispatch to ProseMirror is unreliable — the file shows which it uses).
  - The row's delete button (`Delete "<text>"`) removes that item **and its children**; deleting the only item leaves one empty item (the markdown's `parseTodos` is `[]`) and does not throw (Review Focus 5).
  - `appendRequest` from `0` → `1` appends an empty item at the end and calls `onAppendHandled`; when the last item is already empty it appends nothing and still calls it. A mount with `appendRequest={1}` also appends (the band opens and asks in one press).
  - The checklist toolbar has Bold, Italic, Strike, Code, Link, **Outdent** and **Indent**, and none of the heading/list/quote buttons.
  - `mode` omitted: every existing test unchanged and green.
  - The new Tailwind selectors compile to real rules (the file already compiles the placeholder's five utilities — extend that).

- [ ] **Step 3: Run** `npx vitest run src/features/decks/NoteEditor.test.tsx` — Expected: the new cases FAIL.

- [ ] **Step 4: Implement.** In `NoteEditor.tsx`:

```ts
import { TaskItem, TaskList } from "@tiptap/extension-list";
import { Node } from "@tiptap/react"; // re-exported from @tiptap/core; no @tiptap/extension-document import
// …
export const TODO_PLACEHOLDER = "Add a to-do — Enter for the next, Tab to nest.";

/** A document that is one task list and nothing else — every line is a to-do. */
const ChecklistDocument = Node.create({ name: "doc", topNode: true, content: "taskList" });

/**
 * `TaskItem` with a delete button on every row. The parent's node view is wrapped rather than
 * copied (`this.parent?.()`), so Tiptap's checkbox, its a11y label and its `update` are untouched.
 * The button is `contentEditable=false`, `stopEvent` keeps ProseMirror off it, `ignoreMutation`
 * keeps its own DOM from reading as a document change, and a press deletes the item with its
 * sub-to-dos through `tr.deleteRange` — or, when it is the document's only item, clears it to one
 * empty item, since a task list may not be empty.
 */
const ChecklistItem = TaskItem.extend({
  addNodeView() {
    const parent = this.parent?.();
    return (props) => {
      const view = parent!(props);
      // …append the button, compose stopEvent/ignoreMutation with whatever `view` already has…
      return view;
    };
  },
});

export const CHECKLIST_EXTENSIONS = [
  StarterKit.configure({
    document: false,
    paragraph: {}, bold: {}, italic: {}, strike: {}, code: {},
    heading: false, bulletList: false, orderedList: false, listItem: false, blockquote: false,
    hardBreak: {},
    link: { openOnClick: false },
    codeBlock: false, horizontalRule: false, underline: false, trailingNode: false,
    undoRedo: {}, listKeymap: {}, dropcursor: false,
  }),
  ChecklistDocument,
  TaskList,
  ChecklistItem.configure({
    nested: true,
    a11y: {
      checkboxLabel: (node, checked) =>
        `Mark "${node.textContent || "empty to-do"}" ${checked ? "not done" : "done"}`,
    },
  }),
  Placeholder.configure({ placeholder: TODO_PLACEHOLDER }),
  Markdown,
];
```

Write the doc comment for `CHECKLIST_EXTENSIONS` in `NOTE_EXTENSIONS`' voice: every "off" written out; the dialect is a task list of paragraphs with inline marks; `listKeymap` stays because its default list types include `taskItem`. If `StarterKit.configure` refuses `document: false` or `listKeymap` misbehaves with `listItem: false`, adjust and say why in the comment.

Component: pick `mode === "checklist" ? CHECKLIST_EXTENSIONS : NOTE_EXTENSIONS` **once** (the extension list must not change across renders — `useEditor` with a stable array); a checklist `PROSE` addition as whole literal classes (task list without bullets, `li[data-type=taskItem]` as a flex row with the checkbox label, the checked item's own paragraph `text-dim line-through` — target `>div>p` so a done parent does not strike its children — nested lists indented, the delete button hidden until the row is hovered or has focus-within, a visible focus ring on it via the app's `FOCUS`); the toolbar in checklist mode draws Bold, Italic, Strike, Code, Link, then **Outdent** (`ListIndentDecrease`, `liftListItem("taskItem")`) and **Indent** (`ListIndentIncrease`, `sinkListItem("taskItem")`), hints through `useTooltip()`. The append effect:

```ts
useEffect(() => {
  if (!editor || !appendRequest) return;
  const list = editor.state.doc.firstChild;
  const last = list?.lastChild;
  const lastEmpty = !!last && last.childCount === 1 && last.textContent === "";
  if (list && !lastEmpty) {
    editor.chain()
      .insertContentAt(editor.state.doc.content.size - 1, {
        type: "taskItem", attrs: { checked: false }, content: [{ type: "paragraph" }],
      })
      .run();
  }
  editor.commands.focus("end");
  onAppendHandled?.();
}, [editor, appendRequest]); // onAppendHandled read through a latest-ref so it is not a dep
```

(Adjust the insert position if the test shows it lands inside the last item's paragraph; the test is the authority.)

- [ ] **Step 5: Run** `npx vitest run src/features/decks/NoteEditor.test.tsx src/features/decks/DeckNotesPanel.test.tsx` — Expected: PASS (the second file holds the static-import sweep). Report the measured nested indent width and the hard-break spelling. Do not commit.

---

### Task 5: The band — `DeckTodosPanel`, `useDeckTodos`, and its place in `DeckEditor`

**Read first:** spec §6; `src/features/decks/CLAUDE.md` (*The Notes band* and the card-menu warning, *Views and interaction* on `select-text`, the band placement rules under Tokens & Emblems); `DeckNotesPanel.tsx` (header grammar ~637–711, the wiring/drawing split, the lazy editor ~997); `src/features/home/StickyNoteDialog.tsx` (autosave, flush on unmount); `DeckEditor.tsx:6019–6066`. Invoke the `frontend-design` skill. The Storybook MCP is not connected this session — read the component source and existing stories for props instead of guessing.

**Files:**
- Create: `src/features/decks/useDeckTodos.ts`, `src/features/decks/DeckTodosPanel.tsx`, `DeckTodosPanel.test.tsx`, `DeckTodosPanel.stories.tsx`
- Modify: `src/features/decks/DeckEditor.tsx` (mount after `DeckNotesPanel`, gated on `row`), `src/features/decks/DeckEditor.test.tsx` (add `todosOpen: false` to its `DeckRow` fixture; add the mount/placement and disclosure cases)

**Interfaces:**
- Consumes: `ipc.deckTodos`, `ipc.deckTodosSet`, `DeckRow.todosOpen`, `DeckPatch.todosOpen` (Task 2); `parseTodos`, `countTodos`, `todosText` (Task 3); lazy `NoteEditor` with `mode="checklist"`, `appendRequest`, `onAppendHandled`, `value`, `onChange`, `ariaLabel` (Task 4); `deckTodoListsKey` from `@/features/home/keys` (Task 6 — `["decks", "todos", "lists"]`).
- Produces: `export const deckTodosKey = (deckId: number) => ["decks", "todos", deckId] as const;` and `useDeckTodos(deckId)` in `useDeckTodos.ts`; `DeckTodosPanel({ deckId, open, onToggle })`; the drawing component `TodosBand` with plain props for stories.

- [ ] **Step 1: The hook.**

```ts
export const deckTodosKey = (deckId: number) => ["decks", "todos", deckId] as const;

export function useDeckTodos(deckId: number) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: deckTodosKey(deckId), queryFn: () => ipc.deckTodos(deckId) });
  const save = useMutation({
    mutationFn: (body: string) => ipc.deckTodosSet(deckId, body, null),
    onSuccess: (_answer, body) => {
      queryClient.setQueryData(deckTodosKey(deckId), body);
      void queryClient.invalidateQueries({ queryKey: deckTodoListsKey });
    },
  });
  return {
    body: query.data,
    loaded: query.isSuccess,
    failure: query.isError ? String(query.error) : null,
    save,
  };
}
```

Doc comment: why the band's write does not invalidate `["decks"]` (an autosave per pause would re-read the whole deck; the gallery's `updated_at` catches up at the next deck write, and another window refreshes through the `decks` change mask anyway); why `setQueryData` rather than a refetch.

- [ ] **Step 2: Write the failing tests** (`DeckTodosPanel.test.tsx`), mocking the lazy editor with a `<textarea>` keeping `value`/`onChange`/`ariaLabel` and exposing `appendRequest`/`onAppendHandled` (the `DeckNotesPanel.test.tsx:40` pattern), with fake timers only where `userEvent` is not used (memory: *Fake timers and query notifications*):
  - Closed: the section is named **To-do**, the disclosure is `aria-expanded="false"`, the count reads `2 open · 1 done` from the stored body, and no editor is mounted. An empty list shows no count.
  - Pressing the disclosure calls `onToggle(true)`.
  - Open: the editor is mounted with the stored body; typing saves once, 600 ms after the last change, through `deckTodosSet(deckId, body, null)`; unmounting before 600 ms flushes; blurring flushes.
  - A body with no items is saved as `""` (Review Focus 2).
  - **A refused read mounts no editor** and draws the failure in one line (Review Focus 1); nothing is ever saved.
  - The header count follows the draft as the reader types.
  - **New to-do** while closed calls `onToggle(true)` and the editor receives `appendRequest={1}`; `onAppendHandled` clears it; a second press asks again.
  - Adopting: a new stored body arriving while the editor is not focused and nothing is unsaved remounts the editor with it; arriving while focused, or with a pending save, does not.
  - The section is `shrink-0`, a `<section>` (not an `<aside>`), and its body opts into `select-text`.

- [ ] **Step 3: Run** `npx vitest run src/features/decks/DeckTodosPanel.test.tsx` — Expected: FAIL.

- [ ] **Step 4: Implement** `DeckTodosPanel.tsx` — wiring (`DeckTodosPanel`, calls `useDeckTodos`) and drawing (`TodosBand`, plain props: `open`, `onToggle`, `counts`, `onNewTodo`, `failure`, and the editor slot). Header grammar copied from `DeckNotesPanel`'s (`border-t border-border pt-3`, the disclosure button with `aria-expanded`/`aria-controls` and the rotating `ChevronRight`, the mono count, **New to-do** at `ml-auto` in `META_SUBMIT`'s recipe). The editor behind `React.lazy(() => import("./NoteEditor"))` inside `Suspense` with a sentence for the fallback, `ariaLabel="To-do list"`, `mode="checklist"`. Autosave: a `setTimeout` of 600 ms rescheduled on each change, flushed on the section's blur (focus leaving the section, checked with `relatedTarget`) and on unmount — `StickyNoteDialog`'s mechanism. Store through `todosText(draft)`. Adoption and the draft count are **render-phase adjustments or event-driven**, never a `setState` in an effect body (`react-hooks/set-state-in-effect` only fails at verify): hold `focused` and `pending` as state set from events, and when the query's body differs from the body the editor was last seeded with and neither holds, bump an `editorVersion` used as the editor's `key`.

- [ ] **Step 5: Mount it.** In `DeckEditor.tsx`, directly after the `DeckNotesPanel` element (~6053–6063), gated on `row` like it: `<DeckTodosPanel deckId={deckId} open={row.todosOpen} onToggle={(next) => deck.update.mutate({ todosOpen: next })} />`, with a comment in the notes band's voice (below notes; a section; `shrink-0`; below `PriceStrip` and never between it and the deck). Add `todosOpen: false` to `DeckEditor.test.tsx`'s fixture and a case asserting the To-do section renders after the notes section and its disclosure writes `deckUpdate(id, { todosOpen: true })`.

- [ ] **Step 6: Stories.** `DeckTodosPanel.stories.tsx` (`tags: ["autodocs"]`, title under `Decks/`): closed with counts, open with the seeded nest (the editor reached only through `import()` — copy `NoteEditorDialog.stories.tsx:60–70`'s pattern), empty, and read-failure.

- [ ] **Step 7: Run** `npx vitest run src/features/decks/DeckTodosPanel.test.tsx` — Expected: PASS once Tasks 2–4 have landed; if a sibling's file is still missing, report which import failed rather than stubbing it. Do not run `DeckEditor.test.tsx` mid-fan-out. Report. Do not commit.

---

### Task 6: The home widget — `deckTodos`

**Read first:** spec §7; `docs/reference/home-page.md` (the registry, the layout document's three files, the catalogue, `still`/`editing`); `src/features/home/widgets.ts` (`WidgetMeta`, `deckCompletion` ~503); `widgets.test.ts` (`EVERY_KIND`, the vocabulary pin, `RESERVED_KEYS`, the `WIDGETS.slice(-4)` assertion); `HomePage.tsx` `renderBody` ~225–262 and `renderExtraSettings` ~266–285; `widgets/DeckCompletionWidget.tsx` (rows, `openDeck` ~542, its settings extras ~608–672); `WidgetParts.tsx`; `fit.ts`. Invoke the `frontend-design` skill.

**Files:**
- Create: `src/features/home/widgets/DeckTodosWidget.tsx`, `DeckTodosWidget.test.tsx`, `DeckTodosWidget.stories.tsx`
- Modify: `src/features/home/widgets.ts`, `widgets.test.ts`, `HomePage.tsx`, `HomePage.test.tsx`, `keys.ts`, `keys.test.tsx`

**Interfaces:**
- Consumes: `ipc.deckTodoLists`, `ipc.deckTodosSet`, `ipc.deckUpdate`, `DeckTodoList` (Task 2); `parseTodos`, `countTodos`, `toggleTodo`, `visibleTodos`, `TodoItem` (Task 3); `Inline` from `@/features/decks/noteMarkdown`.
- Produces: `export const deckTodoListsKey: QueryKey = ["decks", "todos", "lists"];` in `keys.ts` (Task 5 imports it); `WidgetKind` member `"deckTodos"`; `DeckTodosWidget` body and `DeckTodosWidgetSettings` extras.

- [ ] **Step 1: The registry row.** Add `"deckTodos"` to `WidgetKind` and to `WIDGET_META` **directly after `stickyNotes`** — catalogue order, and it keeps `WIDGETS.slice(-4)` pinned to round two's four:

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
      ] },
      { key: "order", label: "Order", options: [
        { id: "edited", label: "Last edited" },
        { id: "name", label: "Name" },
        { id: "open", label: "Most open" },
      ] },
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

Match the real `WidgetMeta` field names (read the type; adjust spelling, not substance). Update `widgets.test.ts`: `EVERY_KIND`, the vocabulary pin, and nothing else. Not in `DEFAULT_LAYOUT` (none of its three copies moves).

- [ ] **Step 2: The key.** `deckTodoListsKey` in `keys.ts` with a doc comment (under the `["decks"]` root on purpose: every deck write and the `decks` change mask refresh it; the band's autosave invalidates it by name). A `keys.test.tsx` case pinning its value.

- [ ] **Step 3: Write the failing widget tests** (`DeckTodosWidget.test.tsx`), in the style of `DeckCompletionWidget.test.tsx`:
  - Groups by deck: a heading per deck with its name and (counts on) its open count; items and indented sub-items beneath.
  - `done` off hides completed items but keeps a done parent of an open child; `done` on shows them.
  - `nested` off shows top-level items only.
  - `archived` off leaves archived decks out.
  - `scope: "chosen"` with `deckIds` shows only those decks.
  - `order`: `edited` by `updatedAt` desc, `name` by name (`localeCompare(…, "en")`), `open` by open count desc then name.
  - A deck with nothing visible is left out; no deck at all draws **No to-dos yet** and *Add them in any deck's To-do band.*
  - Ticking an item calls `deckTodosSet(deckId, toggleTodo(body, line), body)` and invalidates `["decks", "todos"]`.
  - A refused tick (the mock rejects with the `TODOS_CHANGED` sentence) refetches and shows the sentence in the widget's one-line failure slot.
  - Pressing a deck heading on a deck whose `todosOpen` is false calls `deckUpdate(deckId, { todosOpen: true })`, then `setActiveView("decks")` then `setOpenDeckId(deckId)` in that order; with `todosOpen` true it skips the update.
  - `still`: pressing a checkbox or a heading does nothing and writes nothing.
  - Checkbox accessible names are `Mark "<text>" done` / `not done`, matching the band's editor.

- [ ] **Step 4: Run** `npx vitest run src/features/home/widgets/DeckTodosWidget.test.tsx` — Expected: FAIL.

- [ ] **Step 5: Implement** `DeckTodosWidget.tsx`: one `useQuery({ queryKey: deckTodoListsKey, queryFn: ipc.deckTodoLists })`; for each list `parseTodos(body)`, then filter (scope via `pinnedDeckIds`, archived), `visibleTodos(items, { showDone, nested })`, drop decks with nothing visible, order, flatten to rows `{ kind: "deck" | "item", depth, … }` and cut whole rows with `fit.fitCount`, with a `+N more` footer for the rest. Item text rendered through the widget's own small `Inline` renderer with **`whitespace-pre-line`**. The tick is a `useMutation` over `ipc.deckTodosSet(deckId, next, body)`; greyed (`aria-disabled`) while in flight; on error `invalidateQueries({ queryKey: ["decks", "todos"] })` and show the error's sentence. The heading's open-deck is DeckCompletionWidget's `openDeck` with the `todosOpen` write in front (await it; on refusal navigate anyway). Settings extras: `DeckTodosWidgetSettings`, a copy of `DeckCompletionWidgetSettings`' `MultiDropdown` writing `{ deckIds, scope: "chosen" }`. Honour `still` and `editing` (read `widgetProps.ts`).

- [ ] **Step 6: Wire** a `case "deckTodos"` in `HomePage.tsx`'s `renderBody` and `renderExtraSettings`. In `HomePage.test.tsx` add the `vi.mock("./widgets/DeckTodosWidget")` stub and the two switch cases like the existing ones — and write the negative check as `/needs a newer version/` (the existing `/came from a newer version/` never matches; fix those two existing assertions too).

- [ ] **Step 7: Story.** `DeckTodosWidget.stories.tsx` (`tags: ["autodocs"]`, `Home/DeckTodosWidget`, a local `Framed` helper like `DeckCompletionWidget.stories.tsx:30`): the seeded lists at 3×3 and 6×3, empty, and completed shown.

- [ ] **Step 8: Run** `npx vitest run src/features/home/widgets/DeckTodosWidget.test.tsx src/features/home/widgets.test.ts src/features/home/keys.test.tsx src/features/home/HomePage.test.tsx` — Expected: PASS once Tasks 2–3 have landed. Report. Do not commit.

---

### Task 7: Docs (after fan-in)

**Files:** `docs/reference/decks-storage.md`, `docs/reference/home-page.md`, `docs/reference/data-and-sync.md`, `src/features/decks/CLAUDE.md`, root `CLAUDE.md`.

- [ ] **Step 1:** `decks-storage.md` — a *Deck to-dos* section: the two columns, why columns and not a table, the three commands and the compare-and-set, no audit/undo, `duplicate_deck` leaves both behind, the mirror's identical-bytes pass.
- [ ] **Step 2:** `home-page.md` — the `deckTodos` row in the widget table (§3) and the commands table (§6), and a short section: settings, the tick's compare-and-set, the heading's open-with-band hand-off, catalogue-only.
- [ ] **Step 3:** `data-and-sync.md` — the v58 row on the schema ladder, in the table's existing shape.
- [ ] **Step 4:** `src/features/decks/CLAUDE.md` — a *The To-do band* section after *The Notes band*: lazy editor only, `select-text`, autosave and adopt-when-idle, the failed-read rule, the empty-checklist rule.
- [ ] **Step 5:** Root `CLAUDE.md` — one sentence in the *Note* paragraph: a **deck to-do list** is a fifth thing that shares the notes' editor and inline dialect and is not a note (`decks.todos`, one per deck, v58).
- [ ] **Step 6:** Every figure re-counted against the tree; no counts a build already answers.

---

### Task 8: Fan-in, verify, live pass, ship (orchestrator)

- [ ] **Step 1:** Stage and commit each task's files separately (`feat(decks): …`, `feat(home): …`, `test: …`), in dependency order 1 → 2 → 3 → 4 → 5 → 6, each with the attribution trailer.
- [ ] **Step 2:** `npm run verify` once. Fix what it names; re-run.
- [ ] **Step 3:** Live pass in the real window (the `running-the-app` skill; take the `app` lock): open a deck, open the To-do band, type a nested list, tick, delete a parent, New to-do while closed; add the widget from the catalogue, tick from it, change each setting, press a heading and land on the deck with the band open; check at 1024 and 1920 wide.
- [ ] **Step 4:** Task 7, then commit docs.
- [ ] **Step 5:** Ship per `auto-pr`: PR body links `Closes #672`, arm auto-merge, bind the PR and turn on Auto-fix, comment on #672 with the PR link and what shipped.
