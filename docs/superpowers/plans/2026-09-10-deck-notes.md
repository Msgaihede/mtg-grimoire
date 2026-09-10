# Deck Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the deck's single `notes` text column with many independent rich-text notes per deck, each able to name any number of cards.

**Architecture:** Two new synced tables — `deck_notes` (title, CommonMark body, sort order) and `deck_note_cards` (attachments by `oracle_id`) — at user schema v43, which also drops `decks.notes` and adds `decks.notes_open`. Rust owns storage, audit, undo and the commands; TypeScript owns every derivation (titles, the noted-card set, the markdown AST). Editing is Tiptap behind `React.lazy`; **reading** goes through a small closed AST so the list, the menu and the card modal load no editor.

**Tech Stack:** Rust + rusqlite, React 19 + TypeScript 6, TanStack Query, Tailwind, Tiptap 3 (`@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/pm`, `@tiptap/markdown`), Vitest, Storybook.

**Spec:** [`docs/superpowers/specs/2026-09-10-deck-notes-design.md`](../specs/2026-09-10-deck-notes-design.md) — read it before starting any task; this plan argues from it and does not restate its reasoning.

**Issue:** [#447](https://github.com/Msgaihede/mtg-grimoire/issues/447)

## Global Constraints

- **Never install `@types/node`.** Its absence is the only fence keeping Node types out of the app program.
- **Add a dependency's narrowest permission, never its `:default`.** (No new Tauri permission is needed here — an app's own `#[tauri::command]` is not ACL-gated.)
- **`USER_SCHEMA_VERSION` becomes 43.** If `main` has moved to 43 or beyond before this merges, renumber the rung **before** merging, and rename the `UNDO_V43` constant and the `user_file_at_42()` fixture to match.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts` and nowhere else.** `src/lib/layers.test.ts` sweeps `src/` and reads doc comments as markup, so do not spell a z-index in prose either.
- **Motion timings come from `src/lib/motion.ts`.** Never a literal duration. `AnimatePresence mode="popLayout"` and `animateView()` are forbidden — both append `<style>` to `document.head` and fail silently under `style-src 'self'`.
- **Dim text is `text-dim`, never `text-muted`.** `src/lib/tokens.test.ts` guards it.
- **Tailwind scans source text for whole class names** — an interpolated class emits no rule at all.
- **A hint is `useTooltip()`'s spread**, never a `title` attribute.
- **Assert the computed accessible name, never the parts.** A CSS `gap` is not a word separator to name computation.
- **`data/` is the user's and is never committed.** Seed user tables only.
- **Do not write a Storybook story, play or test count into any document.**
- **Do not run `npm run verify` inside a task.** Tests run once, at fan-in.
- ⚠️ **When these tasks are run in parallel in one worktree, a task agent runs no `git` command at all and no `cargo` command at all.** Parallel agents share one git index, so a `git add` sweeps a sibling's half-written files into your commit; and concurrent `cargo test` runs on this repo fake around eighteen Rust schema failures, which sends an agent chasing a defect that is not there. The coordinator commits, and runs every suite once at fan-in. **A TS task may run its own single `npm run test:run -- <one file>`**, which takes no shared lock. The per-task `git commit` steps below apply only to a serial, single-agent execution.
- **Every commit message ends with the two attribution lines** given in this session's system reminder.

---

## File ownership

Two agents editing one file in one tree clobber each other. Each task below owns its files exclusively; **do not edit a file another task lists.**

| Task | Owns |
| --- | --- |
| 1 | `src-tauri/src/schema.rs` |
| 2 | `src-tauri/src/sync_engine/capture.rs`, `sync_engine/apply.rs`, `sync_engine/apply/tests.rs`, `src-tauri/src/mirror/watch.rs` |
| 3 | `src-tauri/src/deck_notes.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs` |
| 4 | `src-tauri/src/deck.rs`, `src-tauri/src/deck_audit.rs`, `src-tauri/src/deck_undo.rs` |
| 5 | `src/lib/ipc.ts`, `src/lib/ipc.test.ts` |
| 6 | `src/features/decks/noteMarkdown.ts(+.test.ts)`, `src/features/decks/deckNotes.ts(+.test.ts)` |
| 7 | `src/features/decks/NoteEditor.tsx`, `package.json`, `package-lock.json` |
| 8 | `src/features/decks/DeckNotesPanel.tsx(+.stories.tsx)`, `src/features/decks/useDeckNotes.ts`, `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckEditor.test.tsx` |
| 9 | `src/features/decks/CardMarks.tsx`, `src/features/decks/deckCardMenu.tsx` (+ their tests/stories) |
| 10 | `src/features/card/CardModalRail.tsx`, `src/features/card/NotesOverlay.tsx` (new), `src/lib/store.ts`, `src/App.tsx` |
| 11 | `src/features/decks/DeckSettingsForm.tsx`, `DeckSettingsDialog.tsx`, `CreateDeckDialog.tsx`, `src/features/decks/auditText.ts` (+ their tests/stories) |
| 12 | `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts` |
| 13 | docs, plus the mechanical `notes: null` fixture sweep — **run by the coordinator at fan-in, not by a task agent** |

Waves: **1** = tasks 1–7 and 11–12 in parallel; **2** = tasks 8–10; **3** = task 13, then `npm run verify`.

---

## Task 1: Schema rung v43

**Files:**
- Modify: `src-tauri/src/schema.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `deck_notes` and `deck_note_cards`; `decks.notes_open`; `decks.notes` **gone**; `pub const DECK_NOTE_CARD_GRAIN: &str = "note_id, oracle_id";`; `USER_SCHEMA_VERSION = 43`; `SYNCED_TABLES` at 15 entries.

- [ ] **Step 1: Write the failing rung test**

Add beside the other ladder tests in `schema.rs`:

```rust
#[test]
fn v43_replaces_the_deck_notes_column_with_two_tables() {
    let conn = user_file_at_42();
    migrate_user(&conn).unwrap();

    let v: i64 = conn
        .query_row("PRAGMA main.user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(v, 43);

    // The column is gone.
    let cols: Vec<String> = conn
        .prepare("SELECT name FROM pragma_table_info('decks')")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert!(!cols.iter().any(|c| c == "notes"), "decks.notes survived");
    assert!(cols.iter().any(|c| c == "notes_open"));

    // Both tables and the grain index are here.
    conn.execute_batch(
        "INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('D', 'commander', 0, 0);
         INSERT INTO deck_notes (deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (1, 't', 'b', 0, 0, 0);
         INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (1, 'o1', 0, 0);",
    )
    .unwrap();
    let second = conn.execute_batch(
        "INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (1, 'o1', 0, 0);",
    );
    assert!(second.is_err(), "idx_deck_note_cards_grain did not fire");
}

#[test]
fn a_deck_delete_cascades_to_notes_and_their_attachments() {
    let conn = user_file_at_42();
    migrate_user(&conn).unwrap();
    conn.execute_batch(
        "PRAGMA foreign_keys = ON;
         INSERT INTO decks (name, format_key, created_at, updated_at)
             VALUES ('D', 'commander', 0, 0);
         INSERT INTO deck_notes (deck_id, title, body, sort_order, created_at, updated_at)
             VALUES (1, 't', 'b', 0, 0, 0);
         INSERT INTO deck_note_cards (note_id, oracle_id, created_at, updated_at)
             VALUES (1, 'o1', 0, 0);
         DELETE FROM decks WHERE id = 1;",
    )
    .unwrap();
    let n: i64 = conn
        .query_row("SELECT count(*) FROM deck_note_cards", [], |r| r.get(0))
        .unwrap();
    assert_eq!(n, 0, "the attachment outlived its deck");
}
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd src-tauri && cargo test v43_replaces_the_deck_notes_column`
Expected: FAIL — `user_file_at_42` does not exist yet, and `deck_notes` is not a table.

- [ ] **Step 3: Add the rung**

Bump `USER_SCHEMA_VERSION` to `43`. Append the rung at the bottom of `migrate_user`, after the `v < 42` block and before the clock-repair block:

```rust
    // v43: many deck notes instead of one column (2026-09-10, issue #447).
    //
    // ⚠️ **The three `decks` capture triggers come off first.** They are persistent — the
    // engine writes real `CREATE TRIGGER`s — and `sync_upd_decks` names `notes` in its
    // `AFTER UPDATE OF` list, so SQLite refuses `DROP COLUMN` on a column a trigger
    // references. v33's move, and free for v33's reason: `prepare_database` calls
    // `capture::install` immediately after this function, on every target.
    //
    // **`notes_open` is `DEFAULT 0` and not `1`, which is v37's answer rather than v42's.**
    // v42 gave `stats_open` a `1` because that band was already on screen for every deck on
    // every disk. This band is new, so a collapsed default takes nothing from anybody.
    //
    // **The old paragraph is discarded rather than migrated** — decided 2026-09-10, and the
    // spec's §3 argues it. Nothing here copies `decks.notes` anywhere.
    if v < 43 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "DROP TRIGGER IF EXISTS sync_ins_decks;
             DROP TRIGGER IF EXISTS sync_upd_decks;
             DROP TRIGGER IF EXISTS sync_del_decks;

             CREATE TABLE deck_notes (
                 id INTEGER PRIMARY KEY,
                 deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
                 -- May be empty. The list prints the body's first line when it is, and that
                 -- derivation is computed at render rather than stored: a stored one would go
                 -- stale the moment the body was edited and no writer could notice.
                 title TEXT NOT NULL DEFAULT '',
                 -- CommonMark, in the narrowed dialect `noteMarkdown.ts` pins. Never HTML and
                 -- never ProseMirror JSON: a body Rust can hand to anything as text is what
                 -- keeps a renderer out of this crate.
                 body TEXT NOT NULL DEFAULT '',
                 sort_order INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
              , sync_uid TEXT);
             CREATE TABLE deck_note_cards (
                 id INTEGER PRIMARY KEY,
                 note_id INTEGER NOT NULL REFERENCES deck_notes(id) ON DELETE CASCADE,
                 -- The card's identity across every printing of it. Soft, like every other
                 -- card reference in a user table.
                 oracle_id TEXT NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
              , sync_uid TEXT);
             CREATE UNIQUE INDEX idx_deck_note_cards_grain
                 ON deck_note_cards (note_id, oracle_id);
             CREATE UNIQUE INDEX idx_deck_notes_uid ON deck_notes (sync_uid);
             CREATE UNIQUE INDEX idx_deck_note_cards_uid ON deck_note_cards (sync_uid);

             ALTER TABLE decks DROP COLUMN notes;
             ALTER TABLE decks ADD COLUMN notes_open INTEGER NOT NULL DEFAULT 0;",
        )?;
        // Literal `43`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 43.
        tx.execute_batch("PRAGMA main.user_version = 43;")?;
        tx.commit()?;
    }
```

- [ ] **Step 4: Mirror the rung into `USER_SCHEMA_SQL`**

Add the two `CREATE TABLE {schema}.…` blocks and three `CREATE … INDEX {schema}.…` lines to the head literal, remove `notes TEXT,` from the `decks` block, and splice `notes_open INTEGER NOT NULL DEFAULT 0` onto the end of the one-line `decks` tail. `the_user_schema_is_byte_identical_to_what_the_ladder_builds` compares the two byte for byte — including the `, sync_uid TEXT);` line break.

- [ ] **Step 5: Add the rewind fixture and constant**

```rust
    const UNDO_V43: &str = "DROP INDEX IF EXISTS idx_deck_note_cards_uid;
         DROP INDEX IF EXISTS idx_deck_notes_uid;
         DROP INDEX IF EXISTS idx_deck_note_cards_grain;
         DROP TABLE IF EXISTS deck_note_cards;
         DROP TABLE IF EXISTS deck_notes;
         ALTER TABLE decks DROP COLUMN notes_open;
         ALTER TABLE decks ADD COLUMN notes TEXT;";
```

⚠️ **The `ADD COLUMN notes TEXT` is the half that is easy to forget**, and without it a rewind lands *near* v42 rather than on it. Add `UNDO_V43` to the front of every chain literal that currently starts with `UNDO_V42`, and add a `user_file_at_42()` fixture shaped like `user_file_at_41()`.

- [ ] **Step 6: Update the registries in this file**

- `TABLES`: `("deck_notes", Side::User)` and `("deck_note_cards", Side::User)`.
- `the_user_side_is_the_twenty_five_tables_no_feed_can_rebuild`: both names; the count in the test name and its prose goes 25 → **27**.
- `SYNCED_TABLES`: both names, keeping the array sorted; `[&str; 13]` → `[&str; 15]`.
- `pub const DECK_NOTE_CARD_GRAIN: &str = "note_id, oracle_id";`, added to `every_plain_grain_constant_names_the_index_the_head_schema_carries`'s array as `(DECK_NOTE_CARD_GRAIN, "idx_deck_note_cards_grain")`.

- [ ] **Step 7: Run the schema suite**

Run: `cd src-tauri && cargo test --lib schema::`
Expected: PASS, including the byte-identity test and every rewind chain.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/schema.rs
git commit -m "feat(schema): v43 — deck_notes and deck_note_cards, and decks.notes goes"
```

---

## Task 2: Sync registration

**Files:**
- Modify: `src-tauri/src/sync_engine/capture.rs`, `src-tauri/src/sync_engine/apply.rs`, `src-tauri/src/sync_engine/apply/tests.rs`, `src-tauri/src/mirror/watch.rs`

**Interfaces:**
- Consumes: Task 1's tables and `schema::DECK_NOTE_CARD_GRAIN`.
- Produces: `capture::TABLES` at `[Spec; 15]`, `apply::META` at `[Meta; 15]`.

- [ ] **Step 1: Write the failing wire test**

In `sync_engine/apply/tests.rs`, the test that makes §4 of the spec checkable:

```rust
#[test]
fn a_field_this_build_no_longer_syncs_is_skipped_rather_than_stalling() {
    // A peer still on user schema v42 goes on sending `decks.notes`. This build's `decks`
    // spec has no such field. The op must apply — a deferral here would hold that peer's
    // watermark and stop its whole stream, which is what an unknown *table* costs and what a
    // dropped *column* must not.
    let conn = paired_db();
    let op = op_insert(
        "decks",
        "uid-deck-1",
        json!({ "name": "Atraxa", "format_key": "commander", "notes": "a plan" }),
    );
    let report = apply_ops(&conn, &[op]).unwrap();
    assert_eq!(report.deferred, 0, "a dropped column deferred the op");
    assert_eq!(report.applied, 1);
    let name: String = conn
        .query_row("SELECT name FROM decks WHERE sync_uid = 'uid-deck-1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(name, "Atraxa");
}
```

Match the surrounding file's own helper names — it has established fixtures for a paired database and for building ops; use those rather than the placeholder names above.

- [ ] **Step 2: Run it**

Run: `cd src-tauri && cargo test --lib a_field_this_build_no_longer_syncs`
Expected: FAIL to compile until Task 1's rung lands, then PASS once the `decks` spec drops `notes` — this test guards a property, so seeing it green after Step 3 is the point.

- [ ] **Step 3: Register both tables in `capture.rs`**

Remove `"notes"` from the `decks` `Spec.fields` list. Add, after the `deck_tokens` spec, the two specs given verbatim in the spec document's §4, and change `pub const TABLES: [Spec; 13]` to `[Spec; 15]`.

- [ ] **Step 4: Register both tables in `apply.rs`**

Append to `META`, and change `[Meta; 13]` to `[Meta; 15]`:

```rust
    Meta {
        table: "deck_notes",
        // Appended rather than slotted in, `deck_tokens`' reason: the rank is only ever
        // sorted by, so what it has to say is "after the deck this row hangs off".
        order: 13,
        // **No grain, deliberately.** Two devices each typing a note about the mana base
        // must stay two notes, and there is no column pair that could tell an accidental
        // duplicate from a deliberate one. Uid-only, like `decks` and the folder tables.
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
    Meta {
        table: "deck_note_cards",
        // After `deck_notes`, which is the parent this row hangs off.
        order: 14,
        // **A grain here for the opposite reason to the table above.** Two devices attaching
        // one card to one note describe *one* fact; without this the far op is an insert that
        // lands beside the local row and the card modal reads two notes for one.
        grains: &[Grain {
            predicate: "note_id = ? AND oracle_id = ?",
            sources: &[Source::Parent("note"), Source::Field("oracle_id")],
        }],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
```

- [ ] **Step 5: Add the grain to the written-down index list**

In `apply/tests.rs`, add `idx_deck_note_cards_grain` to `every_unique_index_on_a_synced_table_has_been_decided_about`'s list. `deck_notes` has only its `_uid` index, which that test already excludes by name.

- [ ] **Step 6: Map both tables in `mirror::watch::surface_of`**

```rust
        // **Both are an over-approximation and join anyway**, `deck_tokens`' argument at user
        // schema v37: no mirrored file names a note today, so a write here costs one pass that
        // renders identical bytes. `None` is the arm a reader would have to remember to move
        // the day a format grows a notes section, and being wrong that way costs a file that
        // never catches up.
        "deck_cards" | "deck_categories" | "deck_labels" | "deck_folders" | "deck_tokens"
        | "deck_notes" | "deck_note_cards" => Some(DECKS_ONLY),
```

Add both names to the *mapped* list inside `every_table_in_the_schema_has_been_decided_about`.

- [ ] **Step 7: Run the sync suite**

Run: `cd src-tauri && cargo test --lib sync_engine:: mirror::watch`
Expected: PASS, including `every_synced_table_is_on_the_census`.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sync_engine src-tauri/src/mirror/watch.rs
git commit -m "feat(sync): capture and apply the two note tables, and drop decks.notes from the wire"
```

---

## Task 3: The `deck_notes` module and its commands

**Files:**
- Create: `src-tauri/src/deck_notes.rs`
- Modify: `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs`

**Interfaces:**
- Consumes: Task 1's tables; Task 4's `deck_undo::Op::Notes`, `deck_undo::NoteRow`, `deck_undo::NoteCard`; `crate::deck::touch_deck`; `crate::deck_audit::{record, DECK_LEVEL, DECK}`.
- Produces, in `#[serde(rename_all = "camelCase")]` form:

```rust
pub struct DeckNoteRow {
    pub id: i64,
    pub deck_id: i64,
    pub title: String,
    pub body: String,
    pub sort_order: i64,
    /// The oracle ids this note names, and the card name for each — so no reader has to make
    /// a second round trip to print a submenu. Empty is the ordinary case.
    pub cards: Vec<DeckNoteCard>,
    pub created_at: i64,
    pub updated_at: i64,
}
pub struct DeckNoteCard { pub oracle_id: String, pub name: String }
pub struct CardNoteRow {
    pub id: i64,
    pub deck_id: i64,
    pub deck_name: String,
    pub title: String,
    pub body: String,
}
```

Core functions (all take `&Connection`, all return `Result<_, String>`):

```rust
pub fn list_notes(conn: &Connection, deck_id: i64) -> Result<Vec<DeckNoteRow>, String>;
pub fn create_note(conn: &Connection, deck_id: i64, title: &str, body: &str,
                   oracle_ids: &[String]) -> Result<DeckNoteRow, String>;
pub fn update_note(conn: &Connection, deck_id: i64, id: i64, title: Option<&str>,
                   body: Option<&str>) -> Result<DeckNoteRow, String>;
pub fn delete_note(conn: &Connection, deck_id: i64, id: i64) -> Result<(), String>;
pub fn attach_card(conn: &Connection, deck_id: i64, note_id: i64, oracle_id: &str)
    -> Result<DeckNoteRow, String>;
pub fn detach_card(conn: &Connection, deck_id: i64, note_id: i64, oracle_id: &str)
    -> Result<DeckNoteRow, String>;
pub fn reorder_notes(conn: &Connection, deck_id: i64, ids: &[i64]) -> Result<(), String>;
pub fn notes_for_card(conn: &Connection, oracle_id: &str) -> Result<Vec<CardNoteRow>, String>;
```

Commands, registered as the last path segment: `deck_notes`, `deck_note_create`, `deck_note_update`, `deck_note_delete`, `deck_note_attach`, `deck_note_detach`, `deck_note_reorder`, `card_notes`.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn a_note_survives_being_attached_to_a_card() {
    let conn = deck_db();
    let note = create_note(&conn, 1, "Mana", "Fourteen sources.", &["o-bolt".into()]).unwrap();
    assert_eq!(note.cards.len(), 1);
    // The issue's central requirement: it is still in the list.
    let all = list_notes(&conn, 1).unwrap();
    assert_eq!(all.len(), 1);
    assert_eq!(all[0].id, note.id);
}

#[test]
fn attaching_the_same_card_twice_is_not_an_error_and_adds_no_row() {
    let conn = deck_db();
    let note = create_note(&conn, 1, "t", "b", &[]).unwrap();
    attach_card(&conn, 1, note.id, "o-bolt").unwrap();
    let again = attach_card(&conn, 1, note.id, "o-bolt").unwrap();
    assert_eq!(again.cards.len(), 1, "the grain let a duplicate through");
}

#[test]
fn a_note_belonging_to_another_deck_is_refused_in_words() {
    let conn = deck_db();
    let note = create_note(&conn, 1, "t", "b", &[]).unwrap();
    let err = update_note(&conn, 2, note.id, Some("x"), None).unwrap_err();
    assert!(err.contains("note"), "the refusal did not name what was wrong: {err}");
}

#[test]
fn deleting_a_note_records_history_and_a_reversible_step() {
    let conn = deck_db();
    let note = create_note(&conn, 1, "Mana", "b", &["o-bolt".into()]).unwrap();
    delete_note(&conn, 1, note.id).unwrap();
    assert!(list_notes(&conn, 1).unwrap().is_empty());
    let kinds: Vec<String> = conn
        .prepare("SELECT kind FROM deck_audit WHERE deck_id = 1 ORDER BY id")
        .unwrap()
        .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
    assert_eq!(kinds.last().map(String::as_str), Some("deck"));
    let steps: i64 = conn
        .query_row("SELECT count(*) FROM deck_undo", [], |r| r.get(0)).unwrap();
    assert!(steps > 0, "the delete left nothing to undo");
}

#[test]
fn card_notes_answers_across_every_deck() {
    let conn = deck_db();
    create_note(&conn, 1, "In burn", "b", &["o-bolt".into()]).unwrap();
    create_note(&conn, 2, "In storm", "b", &["o-bolt".into()]).unwrap();
    let found = notes_for_card(&conn, "o-bolt").unwrap();
    assert_eq!(found.len(), 2);
    assert!(found.iter().any(|n| n.deck_id == 2));
}
```

`deck_db()` is a local fixture building two decks over `create_user_schema`. Seed **user tables only** — never `cards` or `sync_meta`. Where `list_notes` needs a card name for an oracle id with no `cards` row, it answers the oracle id itself rather than failing; assert that too.

- [ ] **Step 2: Run them**

Run: `cd src-tauri && cargo test --lib deck_notes::`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the module**

Follow `deck_meta.rs`'s idiom exactly, per write: open `conn.unchecked_transaction()`, refuse in a sentence before touching anything, `crate::deck::touch_deck(&tx, deck_id)?`, `INSERT`/`UPDATE`/`DELETE` **naming no `sync_uid`** (the capture trigger mints it), `record(...)` for the history row, `record_step(...)` for the undo step, `tx.commit()`, then re-read for the readback.

The audit payload rides the existing `deck` kind — `AUDIT_KINDS` stays at nine, because the vocabulary is inside a `CHECK` and a tenth word costs a `deck_audit` rebuild that would cascade `deck_undo` empty on every real launch. Shape:

```rust
&json!({ "field": "note", "action": "create", "note": title, "card": null })
```

with `action` one of `create | edit | delete | attach | detach` and `card` the card's name for the two attachment actions, `null` otherwise.

`list_notes` reads the notes and their attachments in **two statements, not N+1** — one over `deck_notes`, one `LEFT JOIN` from `deck_note_cards` to `cards` for every note id in the deck — then zips them in Rust.

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test --lib deck_notes::`
Expected: PASS.

- [ ] **Step 5: Register the module and the commands**

`lib.rs`: `pub mod deck_notes;` in the "every target" block. `desktop.rs`: the eight commands in the deck block of `generate_handler!`. **No capability entry** — Tauri v2's ACL gates only `core:`/`plugin:` commands.

- [ ] **Step 6: Route them on the web target**

`web/route.rs`: eight `COMMANDS` entries and eight `match` arms, reads through `crate::sync::lock_db_read(state)` and writes through `crate::sync::with_write(state, …)`. Wire keys are camelCase (`deckId`, `noteId`, `oracleId`, `oracleIds`). `every_advertised_command_is_actually_routed` catches a name with no arm; the other direction is invisible, so assert each arm by hand as the file's own note says.

- [ ] **Step 7: Run the route suite**

Run: `cd src-tauri && cargo test --lib web::route`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/deck_notes.rs src-tauri/src/lib.rs src-tauri/src/desktop.rs src-tauri/src/web/route.rs
git commit -m "feat(decks): the deck_notes module, its eight commands and both routes"
```

---

## Task 4: Remove `decks.notes`, and add `Op::Notes`

**Files:**
- Modify: `src-tauri/src/deck.rs`, `src-tauri/src/deck_audit.rs`, `src-tauri/src/deck_undo.rs`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces:

```rust
pub struct NoteRow {
    pub id: i64, pub deck_id: i64, pub title: String,
    pub body: String, pub sort_order: i64,
}
pub struct NoteCard { pub note_id: i64, pub oracle_id: String }

// A fifth arm on `Op`:
Notes {
    #[serde(default)] restore: Vec<NoteRow>,
    #[serde(default)] patch: Vec<NoteRow>,
    #[serde(default)] delete: Vec<i64>,
    #[serde(default)] attachments: Vec<NoteCard>,
},
```

- [ ] **Step 1: Write the failing undo test**

```rust
#[test]
fn a_restored_note_keeps_its_cards_even_when_its_id_was_reused() {
    // `deck_notes.id` is a rowid alias, so deleting the highest-numbered note and writing a
    // new one reuses the number. A single list deciding by "is there a row at this id" would
    // overwrite the reader's newest note with the one they deleted — the failure
    // `a_restored_category_keeps_its_cards_even_when_its_id_was_reused` caught one table over.
    let conn = deck_db();
    // note 1 is deleted, note 1 is then re-made by a different write, and the undo of the
    // first delete must not touch it.
    ...
    let step = Step::new(
        vec![Op::Notes {
            restore: vec![NoteRow { id: 1, deck_id: 1, title: "Mana".into(),
                                    body: "b".into(), sort_order: 0 }],
            patch: vec![], delete: vec![],
            attachments: vec![NoteCard { note_id: 1, oracle_id: "o-bolt".into() }],
        }],
        vec![],
    );
    apply(&conn, &step.undo).unwrap();
    // The reader's newer note is untouched and the restored one is back beside it.
    ...
}
```

Fill the elided setup from the shape of the `Categories` test it names; that test is the template and its assertions transfer term for term.

- [ ] **Step 2: Run it**

Run: `cd src-tauri && cargo test --lib deck_undo::`
Expected: FAIL — `Op::Notes` is not a variant.

- [ ] **Step 3: Add the variant**

Add `Notes` to `Op` with the doc comment the spec's §5 gives, and its arm in `apply`. `restore` and `patch` are two lists for `Categories`' reason. `attachments` is the whole set for the notes in the step, not a diff — the rows cascade away with the note, so the undo has to rebuild them, which is what `Labels`' `carriers` already does. **No `#[serde(alias)]`**: `Notes` has never had another spelling.

- [ ] **Step 4: Remove `notes` from `DECK_FIELDS`**

And delete the test that round-trips `notes` through `read_deck_fields`, replacing its `notes` field with another nullable column on the same list so the null-restore property stays covered.

- [ ] **Step 5: Strip the column from `deck.rs`**

`DeckInput.notes`, `DeckPatch.notes`, `DeckRow.notes`, `DeckBefore.notes`; `d.notes` in `DECK_SELECT`; the create `INSERT`'s column and binding; `notes = coalesce(?8, notes)` and its binding (renumber the remaining placeholders); the before-image `SELECT` and mapper; `duplicate_deck`'s carry; the three doc comments contrasting it with `description`.

⚠️ **`DECK_SELECT` maps by position.** `notes` is column 12, so every `r.get(n)` above 12 shifts down by one, and `IMAGE_COL` goes 27 → 26. The before-image mapper's `r.get(7)` shifts the same way. Read every mapper in the file rather than the two the grep finds.

- [ ] **Step 6: Strip the audit writer**

Delete the `field("notes", …)` arm in `record_deck_edit`. **Leave `deck_audit.rs`'s doc table naming `notes` as a value `deck.field` has held** — history rows are durable and old ones still say it.

- [ ] **Step 7: Run the deck suites**

Run: `cd src-tauri && cargo test --lib deck:: deck_audit:: deck_undo::`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/deck.rs src-tauri/src/deck_audit.rs src-tauri/src/deck_undo.rs
git commit -m "feat(decks): drop decks.notes, and a fifth undo Op for notes"
```

---

## Task 5: The IPC surface

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`

**Interfaces:**
- Consumes: Task 3's DTOs and command names, Task 4's removals.
- Produces:

```ts
export interface DeckNote {
  id: number; deckId: number; title: string; body: string;
  sortOrder: number; cards: DeckNoteCard[];
  createdAt: number; updatedAt: number;
}
export interface DeckNoteCard { oracleId: string; name: string }
export interface CardNote {
  id: number; deckId: number; deckName: string; title: string; body: string;
}

deckNotes(deckId: number): Promise<DeckNote[]>
deckNoteCreate(deckId: number, title: string, body: string, oracleIds: string[]): Promise<DeckNote>
deckNoteUpdate(deckId: number, id: number, patch: { title?: string; body?: string }): Promise<DeckNote>
deckNoteDelete(deckId: number, id: number): Promise<void>
deckNoteAttach(deckId: number, noteId: number, oracleId: string): Promise<DeckNote>
deckNoteDetach(deckId: number, noteId: number, oracleId: string): Promise<DeckNote>
deckNoteReorder(deckId: number, ids: number[]): Promise<void>
cardNotes(oracleId: string): Promise<CardNote[]>
```

Also: `DeckRow.notesOpen: boolean`, `DeckPatch.notesOpen?: boolean`, and **`notes` deleted from `DeckInput`, `DeckPatch` and `DeckRow`.**

- [ ] **Step 1: Add the mirror rows and the call assertions**

Add `["DeckNote", deckNotesRs, "DeckNoteRow"]` and `["CardNote", deckNotesRs, "CardNoteRow"]` to `ipc.test.ts`'s `mirrors` table, and hand-written assertions pinning each new call's wire key names. ⚠️ **`DeckInput` and `DeckPatch` are not on the mirror table** — only `DeckRow` is — so their `notes` removals are covered solely by the hand-written `deckCreate` assertions. Update those in the same commit or the removal is unfenced.

- [ ] **Step 2: Run the test and watch it fail**

Run: `npm run test:run -- src/lib/ipc.test.ts`
Expected: FAIL — no `DeckNote` interface.

- [ ] **Step 3: Write the DTOs and the eight wrappers**

Each with the doc comment convention the file uses: say what the field *is*, and where two fields could be confused, say which is which.

- [ ] **Step 4: Run it**

Run: `npm run test:run -- src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(ipc): the eight note commands, and decks.notes leaves the DTOs"
```

---

## Task 6: The markdown reader and the derivations

**Files:**
- Create: `src/features/decks/noteMarkdown.ts`, `src/features/decks/noteMarkdown.test.ts`, `src/features/decks/deckNotes.ts`, `src/features/decks/deckNotes.test.ts`

**Interfaces:**
- Consumes: Task 5's `DeckNote`.
- Produces:

```ts
export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; text: string }
  | { kind: "em"; text: string }
  | { kind: "strike"; text: string }
  | { kind: "code"; text: string }
  | { kind: "link"; text: string; href: string };

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; inlines: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; inlines: Inline[] }
  | { kind: "paragraph"; inlines: Inline[] };

export function parseNoteBody(body: string): Block[];
export function noteToPlainText(body: string): string;

export function noteTitle(note: DeckNote): string;
export function notedOracleIds(notes: DeckNote[]): ReadonlySet<string>;
export function notesForCard(notes: DeckNote[], oracleId: string | null): DeckNote[];
```

- [ ] **Step 1: Write the failing tests**

```ts
describe("parseNoteBody", () => {
  it("reads the whole dialect", () => {
    expect(parseNoteBody("## Mana")).toEqual([
      { kind: "heading", level: 2, inlines: [{ kind: "text", text: "Mana" }] },
    ]);
    expect(parseNoteBody("- one\n- two")).toEqual([
      { kind: "list", ordered: false, items: [
        [{ kind: "text", text: "one" }], [{ kind: "text", text: "two" }]] },
    ]);
    expect(parseNoteBody("**bold** and `code`")).toEqual([
      { kind: "paragraph", inlines: [
        { kind: "strong", text: "bold" },
        { kind: "text", text: " and " },
        { kind: "code", text: "code" }] },
    ]);
  });

  it("never drops what it does not understand", () => {
    // The rule `releaseNotes.ts` states: a construct with no rule falls through to a
    // paragraph and renders as written. Silence would lose a reader's typing.
    expect(parseNoteBody("| a | b |")).toEqual([
      { kind: "paragraph", inlines: [{ kind: "text", text: "| a | b |" }] },
    ]);
  });
});

describe("noteTitle", () => {
  it("prefers the stored title", () =>
    expect(noteTitle(note({ title: "Mana", body: "# Other" }))).toBe("Mana"));
  it("falls back to the body's first line, unmarked", () =>
    expect(noteTitle(note({ title: "", body: "## Mana base\nmore" }))).toBe("Mana base"));
  it("says so when there is nothing at all", () =>
    expect(noteTitle(note({ title: "", body: "   " }))).toBe("Untitled note"));
});

describe("notesForCard", () => {
  it("answers nothing for a card with no oracle id rather than everything", () =>
    // An orphan printing has `oracleId: null`, and a loose equality here would match every
    // note whose attachment list happened to be empty.
    expect(notesForCard([note({ cards: [] })], null)).toEqual([]));
});
```

- [ ] **Step 2: Run them**

Run: `npm run test:run -- src/features/decks/noteMarkdown.test.ts src/features/decks/deckNotes.test.ts`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write both modules**

`noteMarkdown.ts` is modelled on `src/lib/releaseNotes.ts` — read that file first. It is a **reader for a pinned dialect, not a markdown parser**: no library, no HTML string, and nothing is ever dropped for not being understood.

- [ ] **Step 4: Run them**

Run: `npm run test:run -- src/features/decks/noteMarkdown.test.ts src/features/decks/deckNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/decks/noteMarkdown.ts src/features/decks/noteMarkdown.test.ts src/features/decks/deckNotes.ts src/features/decks/deckNotes.test.ts
git commit -m "feat(decks): a reader for the note dialect, and the four derivations"
```

---

## Task 7: The editor

**Files:**
- Create: `src/features/decks/NoteEditor.tsx`
- Modify: `package.json`, `package-lock.json`

**Interfaces:**
- Consumes: Task 6's dialect.
- Produces: `export default function NoteEditor({ value, onChange, ariaLabel }: { value: string; onChange: (markdown: string) => void; ariaLabel: string }): JSX.Element` — **a default export**, because it is reached only through `React.lazy`.

- [ ] **Step 1: Install the four packages**

```bash
npm i @tiptap/react@3 @tiptap/starter-kit@3 @tiptap/pm@3 @tiptap/markdown@3
```

Measured before writing this plan, `esbuild --bundle --minify`, React external, `gzip -9`: the four together add **141.5 kB gzip** over the app's **481.45 kB**. That is why the component is lazy and why nothing else in the tree may import it eagerly.

- [ ] **Step 2: Write the component**

`useEditor` with `StarterKit` narrowed to exactly the dialect — bold, italic, strike, code, heading levels 1–3, bulletList, orderedList, listItem, blockquote, hardBreak, paragraph, document, text — plus `Link` and `Markdown`. Everything else off. Import `prosemirror-view/style/prosemirror.css` so Vite bundles it; **never** inject a stylesheet at runtime. `onUpdate` calls `onChange(editor.storage.markdown.getMarkdown())`. A small toolbar of `ToggleChip`-shaped buttons over the same marks.

⚠️ The editor's own container needs `LAYER`-free styling and no `title` attributes; a hint is `useTooltip()`'s spread.

- [ ] **Step 3: Write the round-trip test**

`src/features/decks/noteMarkdown.test.ts` is Task 6's file — put this one in `NoteEditor.test.tsx` instead so ownership stays clean:

```tsx
it("round-trips the whole dialect without rewriting it", async () => {
  // The two renderers agree only as long as this holds: Tiptap's markdown out must equal the
  // markdown in for every construct `parseNoteBody` has a rule for. A drift here is a note
  // that changes shape the second time it is opened.
  for (const source of DIALECT_CORPUS) {
    const { editor } = await mountEditor(source);
    expect(editor.storage.markdown.getMarkdown()).toBe(source);
  }
});
```

`DIALECT_CORPUS` is a committed array covering every construct in Task 6's `Block`/`Inline` unions.

- [ ] **Step 4: Run it**

Run: `npm run test:run -- src/features/decks/NoteEditor.test.tsx`
Expected: PASS. A construct that does not round-trip is either removed from the dialect **or** given a custom serializer — do not leave it failing.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/features/decks/NoteEditor.tsx src/features/decks/NoteEditor.test.tsx
git commit -m "feat(decks): a Tiptap note editor, lazy and pinned to one dialect"
```

---

## Task 8: The Notes band

**Files:**
- Create: `src/features/decks/DeckNotesPanel.tsx`, `src/features/decks/DeckNotesPanel.stories.tsx`, `src/features/decks/useDeckNotes.ts`
- Modify: `src/features/decks/DeckEditor.tsx`, `src/features/decks/DeckEditor.test.tsx`

**Interfaces:**
- Consumes: Tasks 5, 6, 7.
- Produces: `<DeckNotesPanel deckId variant open onToggle />`.

- [ ] **Step 1: Read `DeckTokensPanel.tsx` and copy its grammar**

`<section aria-label={NOTES_HEADING} className="shrink-0 border-t border-border pt-3">`, one `ChevronRight` rotated on `open` with `duration-[var(--duration-fast)] ease-standard motion-reduce:transition-none`, `aria-expanded`/`aria-controls`, and a body region that stays in the tree while shut.

- [ ] **Step 2: Write the stories first**

Empty, one note, many notes, a long body, a note naming four cards, and the read-failed state. Storybook is where this component's shape gets settled; `tags: ["autodocs"]` in the meta. **Write no story count anywhere.**

- [ ] **Step 3: Write the panel**

Rows through `metaRows.tsx` — `RowAction` for Edit and a destructive Delete, `CONFIRM_BOX` + `useConfirmFocus` for the confirmation, `META_FIELD` + `META_SUBMIT` for the add form, and `sectionFailure` for the one refusal line. Add-first, which is `LabelsDialog`'s ordering and its reason: a reader with no notes is who this screen is hardest for.

Editing mounts `NoteEditor` through `React.lazy` inside a `Suspense`; reading renders Task 6's blocks. **Nothing on this path may import `NoteEditor` eagerly** — one static import puts 141.5 kB back in the main chunk and nothing goes red.

- [ ] **Step 4: Mount it in `DeckEditor`**

After `DeckStats`, as the last child of the desk column. **Nothing may go between the deck and `PriceStrip`** — the remove tray sits at `-top-3` into that column's own `gap-3`. Wire `open={row.notesOpen}` and `onToggle={(next) => deck.update.mutate({ notesOpen: next })}`.

- [ ] **Step 5: Run the deck editor suite**

Run: `npm run test:run -- src/features/decks/DeckEditor.test.tsx src/features/decks/DeckNotesPanel.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/DeckNotesPanel.tsx src/features/decks/DeckNotesPanel.stories.tsx src/features/decks/useDeckNotes.ts src/features/decks/DeckEditor.tsx src/features/decks/DeckEditor.test.tsx
git commit -m "feat(decks): the Notes band, a third collapsible section"
```

---

## Task 9: The card mark and the card menu

**Files:**
- Modify: `src/features/decks/CardMarks.tsx`, `src/features/decks/deckCardMenu.tsx`, and their tests and stories

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces: `QuantityTag` gains `noted?: boolean`; `deckCardNoteRows(card, notes, onAdd, onOpen): MenuItem[]`.

- [ ] **Step 1: Write the failing tests**

```tsx
it("names both marks and the quantity in one phrase", () => {
  // A CSS gap is not a word separator to name computation, so the parts must be one text
  // node. `Missing2` is the bug this rule exists to prevent.
  render(<QuantityTag quantity={4} name="Ramp" color="#3b7d3b" gameChanger noted />);
  expect(screen.getByRole("img")).toHaveAccessibleName(
    "Ramp · 4 in this pile · Game changer · Has a note",
  );
});
```

- [ ] **Step 2: Run it**

Run: `npm run test:run -- src/features/decks/CardMarks.test.tsx`
Expected: FAIL — `noted` is not a prop.

- [ ] **Step 3: Add the glyph**

Folded **into** `QuantityTag` beside `crowned`, never as a new corner. `CardMarks.tsx`'s own argument at the bottom of the file says why: the marks strip is `overflow-hidden` and was measured overflowing a 165 px tile by 11 px, and `crowned` is the precedent for a fifth fact — folded in at a cost of 14 px rather than drawn beside. A card that is both a Game Changer and noted shows **both glyphs and the quantity**.

The glyph takes **no colour of its own**: the `--color-pie-*` deeps are spoken for by labels and gold is spoken for by selection. On the two row views it sits beside `LabelDot` and separates from it by shape — a glyph against an 8 px filled square.

- [ ] **Step 4: Add the menu rows**

Under their own separator in `deckCardMenu.tsx`: `Add note…`, always present, opening the editor with the card already attached; and `Notes ▸`, a submenu of the notes naming this card, present **only when there are any**. A greyed row's accessible name has to include its reason, so an unavailable row is absent rather than disabled.

- [ ] **Step 5: Run the suites**

Run: `npm run test:run -- src/features/decks/CardMarks.test.tsx src/features/decks/deckCardMenu.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/CardMarks.tsx src/features/decks/deckCardMenu.tsx src/features/decks/CardMarks.test.tsx src/features/decks/deckCardMenu.test.tsx
git commit -m "feat(decks): a note glyph beside the crown, and two card-menu rows"
```

---

## Task 10: The card modal's Notes row

**Files:**
- Create: `src/features/card/NotesOverlay.tsx`
- Modify: `src/features/card/CardModalRail.tsx`, `src/lib/store.ts`, `src/App.tsx`

**Interfaces:**
- Consumes: Tasks 5, 6.
- Produces: `CardOverlay` gains `"notes"`.

- [ ] **Step 1: Add the rail row**

`{ label: "Notes", onSelect: overlay("notes") }` in the first block, after `Combos`. **A noun, not a verb** — every row in that block names the surface it opens and every row below it says where the press goes; `Combos`' comment states the rule.

- [ ] **Step 2: Write the overlay with four states**

`Combos`' `ComboState` is the precedent and the reason is the same: notes for this card, **no** notes for this card, the read in flight, and the read failed are four states, three of which look like an empty list. Silence may never imply the second.

Mount it in `App.tsx` as a sibling of the shell, **never as a child of the modal** — `CardDetailModal` asks `Dialog` for `container`, and `container-type` implies layout containment, so a `fixed inset-0` scrim inside it resolves against the panel with nothing going red.

- [ ] **Step 3: Write the failing test**

```tsx
it("says a card has no notes rather than showing nothing", async () => {
  render(<NotesOverlay oracleId="o-bolt" />, { notes: [] });
  expect(await screen.findByText(/no notes/i)).toBeInTheDocument();
});
it("says the read failed rather than showing the same emptiness", async () => {
  render(<NotesOverlay oracleId="o-bolt" />, { fail: true });
  expect(await screen.findByRole("alert")).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the suite**

Run: `npm run test:run -- src/features/card/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/card/NotesOverlay.tsx src/features/card/CardModalRail.tsx src/lib/store.ts src/App.tsx
git commit -m "feat(card): a Notes row on the rail, answering across every deck"
```

---

## Task 11: Remove the old Notes field from the two dialogs

**Files:**
- Modify: `src/features/decks/DeckSettingsForm.tsx`, `DeckSettingsDialog.tsx`, `CreateDeckDialog.tsx`, `src/features/decks/auditText.ts`, and their tests and stories

- [ ] **Step 1: Delete the textarea and its wiring**

`DeckSettingsForm.tsx`'s `notes` label and `<textarea>`, its `DeckSettingsFormProps.value.notes`, `DeckSettingsDialog`'s `writeNotes`/`useDeckField`/`change`/`commit`/`value` routing, and `CreateDeckDialog`'s `notes: ""` draft and `trimmedOrAbsent(value.notes)` payload line.

- [ ] **Step 2: Leave `auditText.ts`'s `case "notes"` exactly where it is**

⚠️ **Do not delete it.** Audit rows are durable and every history row written before v43 still says `notes`; removing the arm would silently demote years of history to the default `Changed the deck`. Add the new `field: "note"` arm beside it, printing `Added a note`, `Edited a note`, `Deleted a note`, `Attached <card> to a note` and `Detached <card> from a note` — and, like its neighbour, never the body.

- [ ] **Step 3: Update the tests and stories**

Delete the notes assertions in `DeckSettingsForm.test.tsx`, `DeckSettingsDialog.test.tsx` (including *"commits a half-typed notes draft when the dialog closes"*) and `CreateDeckDialog.test.tsx`, and the notes typing in both stories files. Add an `auditText.test.ts` case per new sentence, **and keep the existing `Edited the deck notes` case** — it is a test of how old history reads.

- [ ] **Step 4: Run the suites**

Run: `npm run test:run -- src/features/decks/DeckSettingsForm.test.tsx src/features/decks/DeckSettingsDialog.test.tsx src/features/decks/CreateDeckDialog.test.tsx src/features/decks/auditText.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/decks/DeckSettingsForm.tsx src/features/decks/DeckSettingsDialog.tsx src/features/decks/CreateDeckDialog.tsx src/features/decks/auditText.ts src/features/decks/*.test.tsx src/features/decks/*.stories.tsx src/features/decks/auditText.test.ts
git commit -m "feat(decks): the single Notes field leaves both deck dialogs"
```

---

## Task 12: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts`

- [ ] **Step 1: Remove `FakeDeck.notes`**

And `toDeckRow`'s emission, `deck_create`'s `notes` handling, `deck_update`'s `coalesce` line and its audit diff row, `DefaultedDeckColumn`'s entry and null default, and the three seeded decks' prose bodies.

- [ ] **Step 2: Add the two fake tables and eight handlers**

`FakeDeckNote`, `FakeDeckNoteCard`, `deck_notes`, `deck_note_create`, `deck_note_update`, `deck_note_delete`, `deck_note_attach`, `deck_note_detach`, `deck_note_reorder`, `card_notes`. Add `notesOpen` to `toDeckRow` and to `deck_update`'s accepted patch.

⚠️ **Grep will call `db.ts` binary** if a stray NUL lands in it — a "no matches" there can be a lie. If a search comes back suspiciously empty, check with `grep -a`.

- [ ] **Step 3: Seed one deck with two notes**

One naming two cards, one naming none, so the band's stories and the marks have something to draw. Seed **user tables only**.

- [ ] **Step 4: Run the fake's own suite**

Run: `npm run test:run -- .storybook/fake/db.test.ts .storybook/fake/world.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add .storybook/fake
git commit -m "test(storybook): the fake grows two note tables and loses decks.notes"
```

---

## Task 13: Fan-in — the fixture sweep, the docs, and verify

**Run by the coordinator after every other task is in, not by a task agent.**

- [ ] **Step 1: Sweep the `notes: null` deck fixtures**

Ten test files carry a `DeckRow` fixture with `notes: null` and will not compile once Task 5 lands: `CategoriesDialog.test.tsx`, `DeckEditor.test.tsx`, `deckFilter.test.ts`, `deckMenu.test.tsx`, `deckSort.test.ts`, `useDeck.test.ts`, `useDecks.test.ts`, `DecksPage.test.tsx`, `CreateDeckDialog.test.tsx`, `src/App.test.tsx`. Delete the line and add `notesOpen: false`.

⚠️ Use `tsc --noEmit` as the authority for which files these are — IDE diagnostics are stale mid-write, and a grep for `notes:` also matches `collection` and `wish` fixtures on four other DTOs.

- [ ] **Step 2: Update the docs**

- `docs/reference/decks-storage.md` — a new section for the two tables, the eight commands, the audit payload and the undo Op; and `:828`'s `DeckInput` sentence loses `notes`.
- `docs/reference/data-and-sync.md` — the schema ladder gains v43.
- `docs/reference/sync.md` — "thirteen tables" becomes **fifteen** everywhere it is stated, the logical-grain table gains `deck_note_cards`, and §4's dropped-column property gets a paragraph naming the test that proves it.
- `docs/reference/frontend-design.md` — the note glyph beside the crown.
- `src/features/decks/CLAUDE.md` — the band, and the sentence listing what `DeckSettingsForm` draws loses `notes`.
- `src-tauri/CLAUDE.md` — the two tables in whatever census it keeps.
- `CLAUDE.md` — one line in the reference table if a new doc appears.

⚠️ **A prose-only edit routes to neither CI job**, so re-count every list you touch in the same commit. `SYNCED_TABLES` is the count most likely to be left at thirteen.

- [ ] **Step 3: Run the whole thing**

Run: `npm run verify`
Expected: PASS. ⚠️ **Never run two verifies at once** — concurrent runs fake ~18 Rust schema failures. ⚠️ **Do not pipe it** — `| tail` reports tail's exit code while tests fail.

- [ ] **Step 4: Run the two things verify does not**

Run: `cd src-tauri && cargo fmt --check && cargo clippy --all-targets -- -D warnings`
Expected: PASS. These are the only reds a green `verify` allows.

- [ ] **Step 5: Prove the migration on the real dev database**

A worktree's fresh database can never show an upgrade bug. Copy `src-tauri/target/debug/data/` from the main checkout, launch, and confirm the rung ran, the band draws, and no deck lost anything but the old field.

- [ ] **Step 6: Drive the shipped window**

`npm run tauri dev` (take the app lock first — one app across every worktree), then CDP per `docs/reference/live-ui-verification.md`. Confirm: the band opens and remembers, a note survives a reload, the glyph draws beside the crown on a Game Changer, the card menu adds a note, and the card modal answers across two decks.

⚠️ **The CSP check is only real in a built binary** — `devCsp` carries `style-src 'unsafe-inline'` and would hide exactly the failure the editor was cleared against. Build once and open a note.

- [ ] **Step 7: Ship**

`shipping-a-branch`, then `auto-pr`. The PR body closes #447.
