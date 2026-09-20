# Sticky Notes Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tenth home-page widget kind, `stickyNotes`, drawing a stack of rich-text notes the reader writes, stored in a new synced table.

**Architecture:** One new synced table — `sticky_notes` (title, CommonMark body, colour, pinned, sort order) at user schema v46 — with five commands in `sticky_notes.rs`. The widget is a registry row plus one body component that draws two layouts (Board, the default; Pad, the option). Editing is a dialog that mounts the existing `NoteEditor` behind `React.lazy`; **reading** goes through the existing `parseNoteBody` / `noteToPlainText`, so the widget loads no editor. Rust stores strings and validates nothing about a colour; TypeScript decides what a colour means, what a note is titled and what fits.

**Tech Stack:** Rust + rusqlite, React 19 + TypeScript 6, TanStack Query, Tailwind v4, Tiptap 3 (already installed, reused unchanged), Vitest, Storybook.

**Spec:** [`docs/superpowers/specs/2026-09-20-sticky-notes-widget-design.md`](../specs/2026-09-20-sticky-notes-widget-design.md) — read it before starting any task; this plan argues from it and does not restate its reasoning.

**Design:** [Sticky Notes Widget — Concepts](https://claude.ai/artifact/CH3UweXFxCNhq8ZW4Vz51J) — the artboards are the visual target for tasks 9 and 10.

**Issue:** [#479](https://github.com/Msgaihede/mtg-grimoire/issues/479)

## Global Constraints

- **`USER_SCHEMA_VERSION` becomes 46.** ⚠️ If `main` has moved to 46 or beyond before this merges, renumber the rung **before** merging and rename `UNDO_V46` to match. A collision is invisible to git because both branches write the same line — `grep USER_SCHEMA_VERSION src-tauri/src/schema.rs` is the only thing that settles it. There is no `user_file_at_45()` fixture to rename: they stop at 44, and an uncalled one is a `dead_code` warning CI turns red.
- **Never install `@types/node`.** Its absence is the only fence keeping Node types out of the app program.
- **Add a dependency's narrowest permission, never its `:default`.** No new Tauri permission is needed here — an app's own `#[tauri::command]` is not ACL-gated, and `capabilities/` must not grow an entry.
- **Nothing may import `NoteEditor` statically.** `src/features/decks/DeckNotesPanel.test.tsx:691` sweeps all of `src/` for it. Use `lazy(() => import("@/features/decks/NoteEditor"))`. ⚠️ The sweep excuses only `/NoteEditor.` and `.test.` — **a `.stories.tsx` file is in scope**, so a story may name the module in prose but never in an import.
- **Dim text on a note surface is `--color-note-dim`, never `text-dim`.** Measured at ~4.3:1 against the L 26% fills, under the 4.5:1 floor. `text-dim` stays correct on the page background.
- **A note's colour is set inline from a custom property, never as a Tailwind class.** A mistyped Tailwind arbitrary value emits no rule at all rather than failing.
- **Any renderer of note blocks sets `whitespace-pre-line`.** A hard break travels as a `"\n"` inside a text run; without it the line boundary is drawn as a space.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts` and nowhere else.** `src/lib/layers.test.ts` sweeps `src/` and reads doc comments as markup, so do not spell a z-index in prose either.
- **Motion timings come from `src/lib/motion.ts`.** Never a literal duration. `AnimatePresence mode="popLayout"` and `animateView()` are forbidden. Any `transition-*` needs a `motion-reduce:` opt-out within 400 characters — `src/lib/tokens.test.ts` sweeps for it.
- **Tailwind scans source text for whole class names** — an interpolated class emits no rule, and a class named in a *comment* is a class Tailwind emits.
- **A hint is `useTooltip()`'s spread**, never a `title` attribute. Use `aria-disabled`, never `disabled`.
- **Assert the computed accessible name, never the parts.** A CSS `gap` is not a word separator to name computation.
- **`data/` is the user's and is never committed.** Seed user tables only.
- **Do not write a Storybook story, play or test count into any document.**
- **Do not run `npm run verify` inside a task.** Tests run once, at fan-in.
- ⚠️ **When these tasks are run in parallel in one worktree, a task agent runs no `git` command at all and no `cargo` command at all.** Parallel agents share one git index, so a `git add` sweeps a sibling's half-written files into your commit; and concurrent `cargo test` runs on this repo fake around eighteen Rust schema failures, which sends an agent chasing a defect that is not there. The coordinator commits, and runs every suite once at fan-in. **A TS task may run its own single `npm run test:run -- <one file>`**, which takes no shared lock. The per-task `git commit` steps below apply only to a serial, single-agent execution.
- **Every commit message ends with the two attribution lines** given in this session's system reminder.

---

## Shared vocabulary

Every task uses these exact names. A task that spells one differently is a bug the next task discovers.

```rust
// src-tauri/src/sticky_notes.rs
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteRow {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}
```

```ts
// src/lib/ipc.ts
export interface StickyNote {
  id: number;
  title: string;
  body: string;
  color: string;
  pinned: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface StickyNotePatch {
  title?: string;
  body?: string;
  color?: string;
  pinned?: boolean;
}
```

```ts
// src/features/home/stickyNotes.ts
export const NOTE_COLORS = ["amber", "jade", "azure", "rose", "slate"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];
```

---

## File ownership

Two agents editing one file in one tree clobber each other. Each task below owns its files exclusively; **do not edit a file another task lists.**

| Task | Owns |
| --- | --- |
| 1 | `src-tauri/src/schema.rs` |
| 2 | `src-tauri/src/sync_engine/capture.rs`, `sync_engine/apply.rs`, `sync_engine/apply/tests.rs`, `src-tauri/src/mirror/watch.rs` |
| 3 | `src-tauri/src/sticky_notes.rs` (new), `src-tauri/src/lib.rs`, `src-tauri/src/desktop.rs`, `src-tauri/src/web/route.rs` |
| 4 | `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/userTables.json`, `src/lib/crossWindow.ts` (+ its test) |
| 5 | `src/index.css` |
| 6 | `src/features/home/stickyNotes.ts` (+ `.test.ts`) |
| 7 | `src/features/home/useStickyNotes.ts`, `src/features/home/keys.ts` (+ `keys.test.tsx`) |
| 8 | `src/features/home/StickyNoteDialog.tsx` (+ `.stories.tsx`) |
| 9 | `src/features/home/widgets/StickyNotesWidget.tsx` (+ `.test.tsx`, `.stories.tsx`) |
| 10 | `src/features/home/widgets.ts`, `widgets.test.ts`, `HomePage.tsx`, `HomePage.test.tsx` |
| 11 | `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts` |
| 12 | docs — **run by the coordinator at fan-in, not by a task agent** |

**Waves:** **1** = tasks 1–7 and 11 in parallel; **2** = tasks 8 and 9; **3** = task 10; **4** = task 12, then `npm run verify`.

---

## Task 1: Schema rung v46

**Files:**
- Modify: `src-tauri/src/schema.rs` — `USER_SCHEMA_VERSION` (:424), `TABLES` (:503+), `SYNCED_TABLES` (:655), `USER_SCHEMA_SQL` (:3601+), the ladder bottom (after the `v < 45` rung at :6274), `mod tests` (`UNDO_V*` at :7897+, the chain literals at :8288/:8320/:8347/:8374, the prose count at :7663, the version assertion at :9168)

**Interfaces:**
- Consumes: nothing.
- Produces: the table `sticky_notes (id, title, body, color, pinned, sort_order, created_at, updated_at, sync_uid)` and `idx_sticky_notes_uid`. Task 2 registers it with sync; task 3 reads and writes it.

- [ ] **Step 1: Confirm the rung number is still free**

```bash
grep -n "USER_SCHEMA_VERSION\|if v < 4" src-tauri/src/schema.rs | tail -20
```

Expected: `pub const USER_SCHEMA_VERSION: u32 = 45;` and the last rung is `if v < 45 {`. **If either says 46 or higher, use the next free number everywhere below and rename `UNDO_V46` and `user_file_at_45()` to match.**

- [ ] **Step 2: Write the failing rewind test constant**

In `mod tests`, immediately above `const UNDO_V45`:

```rust
    /// v46 added `sticky_notes`. Owed for the quiet reason: the rung is
    /// `CREATE TABLE IF NOT EXISTS`, so a fixture that left the table standing would climb
    /// perfectly happily and claim a version that never had it — green, and lying.
    const UNDO_V46: &str = "DROP INDEX IF EXISTS idx_sticky_notes_uid;
         DROP TABLE IF EXISTS sticky_notes;";
```

Then put `{UNDO_V46} ` at the **front** of every chain literal — rewinds walk the ladder backwards.

⚠️ **There are sixteen of them, not the handful a glance at the file suggests.** Count before you start and count after, and do not trust a line-number list — a fixture you miss rewinds to the wrong shape and then climbs green, claiming a version it never had.

```bash
grep -c '"{UNDO_V45}' src-tauri/src/schema.rs
```

- [ ] **Step 3: Run the schema tests to verify they fail**

Run: `cd src-tauri && cargo test --lib schema::tests`
Expected: FAIL — `the_user_schema_is_byte_identical_to_what_the_ladder_builds` and the version assertion, because the rung and the head schema do not exist yet.

- [ ] **Step 4: Add the rung at the bottom of `migrate_user`**

Immediately after the `if v < 45 { … }` block:

```rust
    if v < 46 {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE IF NOT EXISTS sticky_notes (
                 id INTEGER PRIMARY KEY,
                 -- May be empty. The widget prints the body's first line when it is, and that
                 -- derivation is computed at render rather than stored: a stored one would go
                 -- stale the moment the body was edited and no writer could notice.
                 title TEXT NOT NULL DEFAULT '',
                 -- CommonMark, in the narrowed dialect `noteMarkdown.ts` pins. Never HTML and
                 -- never ProseMirror JSON: a body Rust can hand to anything as text is what
                 -- keeps a renderer out of this crate.
                 body TEXT NOT NULL DEFAULT '',
                 -- One of five names the page knows. **No CHECK, deliberately**: this table is
                 -- synced, and a constraint here would make a build that adds a sixth colour
                 -- emit rows this build refuses at apply. The page maps an unknown word to
                 -- `slate`, which is `widgets.ts`' rule for a stored value no option carries.
                 color TEXT NOT NULL DEFAULT 'slate',
                 pinned INTEGER NOT NULL DEFAULT 0,
                 sort_order INTEGER NOT NULL,
                 created_at INTEGER NOT NULL,
                 updated_at INTEGER NOT NULL
              , sync_uid TEXT);
             CREATE UNIQUE INDEX IF NOT EXISTS idx_sticky_notes_uid
                 ON sticky_notes (sync_uid);",
        )?;
        // Literal `46`, for the reason every step before it writes its own: this step is what
        // *makes* a database version 46.
        tx.execute_batch("PRAGMA main.user_version = 46;")?;
        tx.commit()?;
    }
```

- [ ] **Step 5: Add the same DDL to `USER_SCHEMA_SQL` at head shape**

⚠️ **Byte-identical to what the ladder builds.** Copy the `CREATE TABLE` body verbatim, with `{schema}.` on the table and index names and the `, sync_uid TEXT);` on its own line exactly as above. Place it beside the other note tables (`deck_notes` is at :4040) and the index beside the other uid indexes (:4193).

- [ ] **Step 6: Bump the version and register the table**

`schema.rs:424`:

```rust
pub const USER_SCHEMA_VERSION: u32 = 46;
```

In `TABLES`, in its sorted position:

```rust
    // The reader's prose about nothing in particular (user schema v46), drawn by the home
    // page's `stickyNotes` widget. Emphatically theirs and rebuildable by nothing — the
    // second table on this list whose whole content is typing.
    ("sticky_notes", Side::User),
```

In `SYNCED_TABLES`, in its sorted position (after `"muted_tags"`), and change the array length to `[&str; 16]`.

- [ ] **Step 7: Move every count that is written down — there are eight, not the two or three you will find first**

1. the literal `assert_eq!(USER_SCHEMA_VERSION, 45)` → 46
2. `assert_eq!(SYNCED_TABLES.len(), 15)` → 16
3. `SYNCED_TABLES`' own doc head — "Fifteen … five moves" → sixteen, six
4. `USER_SCHEMA_SQL`'s doc — "the twenty-nine user tables and their forty-six indexes"
5. `create_user_schema`'s doc — "Create the twenty-nine user tables"
6. `stray, 29` and the sentence beside it — "the user file holds the twenty-nine and nothing else"
7. `want.len()` — it is tables + indexes + autoindexes, so **78 → 80**
8. `the_user_side_is_the_twenty_nine_tables_no_feed_can_rebuild` — the **test's own name** carries the count, so it is renamed as well as having `sticky_notes` added to its spelled-out list
9. ⚠️ **Five rung tests assert *head's* version as a literal**, because `migrate_user` climbs the whole ladder — so every rung moves all five. Three are commented as such in the v36 block; the other two (`v41_gives_a_database_the_share_cache`, `v43_replaces_the_deck_notes_column_with_two_tables`) are not. **Naming them has failed twice**: v43 left v41's red, and v46 left v43's red. Do not work from a list — bump what you find, then run `cargo test --lib schema::tests`, and each one you missed names itself in a `left: <head>, right: <old>` panic

⚠️ **Re-count the indexes; do not add one to the number written there.** Extract the `USER_SCHEMA_SQL` raw string and count lines matching `^CREATE (UNIQUE )?INDEX ` — it was 46 and becomes 47. Autoindexes stay at 3, because `sticky_notes` has an `INTEGER PRIMARY KEY` and so brings no `sqlite_autoindex` row; that is what makes `want.len()` 80 rather than 81.

```bash
grep -n "twenty-nine\|forty-six\|USER_SCHEMA_VERSION, 45\|SYNCED_TABLES.len()\|no_feed_can_rebuild\|stray," src-tauri/src/schema.rs
```

- [ ] **Step 8: Run the schema tests to verify they pass**

Run: `cd src-tauri && cargo test --lib schema::tests`
Expected: PASS. If `the_user_schema_is_byte_identical_to_what_the_ladder_builds` still fails, the diff it prints is whitespace between the rung and `USER_SCHEMA_SQL` — they are compared string for string.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/schema.rs && git commit -m "feat(schema): add sticky_notes at user schema v46"
```

---

## Task 2: Sync registration

**Files:**
- Modify: `src-tauri/src/sync_engine/capture.rs` (`TABLES` at :108), `src-tauri/src/sync_engine/apply.rs` (`META` at :171), `src-tauri/src/sync_engine/apply/tests.rs`, `src-tauri/src/mirror/watch.rs` (`surface_of` at :98, the decided-about list at :1064+)

**Interfaces:**
- Consumes: task 1's `sticky_notes` table and `idx_sticky_notes_uid`.
- Produces: the capture triggers that mint `sync_uid`. Task 3 relies on them — **no INSERT it writes may name `sync_uid`.**

- [ ] **Step 1: Run the census tests to verify they fail**

Run: `cd src-tauri && cargo test --lib sync_engine::capture::tests::every_synced_table_is_on_the_census`
Expected: FAIL — "a synced table with no capture spec never syncs", because task 1 put `sticky_notes` on `SYNCED_TABLES` and nothing answers it here.

- [ ] **Step 2: Add the `capture::Spec`**

In `TABLES`, in its position, and change the array length to `[Spec; 16]`:

```rust
    Spec {
        table: "sticky_notes",
        keys: &["id"],
        fields: &["title", "body", "color", "pinned", "sort_order"],
        counters: &[],
        // Hangs off nothing — not an omission: `parents: &[]` is what "belongs to the reader
        // and to nothing else" is spelled as here, and `deck_labels`, `device_names` and
        // `muted_tags` already carry it.
        parents: &[],
        append_only: false,
    },
```

⚠️ `created_at` and `updated_at` are on no field list — syncing a timestamp would put two answers to "when" in the database.

- [ ] **Step 3: Add the `apply::Meta`**

In `META`, appended at the end, and change the array length to `[Meta; 16]`:

```rust
    Meta {
        table: "sticky_notes",
        // Appended rather than slotted in, `deck_tokens`' and `deck_notes`' reason: the rank
        // is only ever sorted by, and this row hangs off nothing, so it may land anywhere.
        order: 15,
        // **No grain, deliberately.** Two devices each typing a note about the same thing
        // must stay two notes, and there is no column pair that could tell an accidental
        // duplicate from a deliberate one. Uid-only, like `deck_notes`.
        grains: &[],
        counters: &[],
        timestamps: true,
        needs_review: false,
        tree: None,
    },
```

- [ ] **Step 4: Decide the table in `mirror::watch::surface_of`**

⚠️ The default arm is `_ => None`, so a table nobody decides about is **silently** invisible to the plain-text mirror. Add the arm explicitly beside `activity` and `app_meta`, and add `"sticky_notes"` to the written-down list that `every_table_in_the_schema_has_been_decided_about` reads:

```rust
        // A sticky note is neither a deck nor the collection, so it reaches no mirror
        // surface. Decided about rather than left to the default arm, which is what the
        // test below exists to force.
        "sticky_notes" => None,
```

- [ ] **Step 5: Leave the apply-side decision list alone, and say why in a comment**

⚠️ **Adding the index here turns the test red.** `every_unique_index_on_a_synced_table_has_been_decided_about` reads every UNIQUE index off a live `SYNCED_TABLES`, but skips a table's own uid index by name — `if name == format!("idx_{table}_uid") { continue; }` — so `idx_sticky_notes_uid` never reaches `found` and an entry for it makes `assert_eq!` fail. The list is keyed `"{table}.{name}"` besides, so a bare spelling would not match anyway. `deck_notes` is the precedent: **absent**, with a comment saying so.

Write the equivalent comment where `sticky_notes` would have sorted, and change no assertion.

- [ ] **Step 6: Run the sync tests to verify they pass**

Run: `cd src-tauri && cargo test --lib sync_engine mirror::watch`
Expected: PASS — including `every_column_a_spec_names_exists_on_its_table`, which is what catches a misspelt field name here rather than at a reader's next write.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sync_engine src-tauri/src/mirror && git commit -m "feat(sync): register sticky_notes as the sixteenth synced table"
```

---

## Task 3: The `sticky_notes` module and its commands

**Files:**
- Create: `src-tauri/src/sticky_notes.rs`
- Modify: `src-tauri/src/lib.rs` (module map), `src-tauri/src/desktop.rs` (`generate_handler!`), `src-tauri/src/web/route.rs` (`COMMANDS` + match arms)

**Interfaces:**
- Consumes: task 1's table; task 2's capture triggers.
- Produces: five commands — `sticky_notes` → `Vec<StickyNoteRow>`; `sticky_note_create(title: String, body: String, color: String)` → `i64`; `sticky_note_update(id: i64, title: Option<String>, body: Option<String>, color: Option<String>, pinned: Option<bool>)` → `()`; `sticky_note_delete(id: i64)` → `()`; `sticky_note_reorder(ids: Vec<i64>)` → `()`. Task 4 binds all five.

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/sticky_notes.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    // ⚠️ `create_user_schema` takes two arguments (`conn, schema`), so it is not the fixture
    // here. `memory_pair()` is what every other module's user-side test uses.
    fn db() -> rusqlite::Connection {
        crate::schema::memory_pair()
    }

    #[test]
    fn a_new_note_lands_last_and_is_read_back() {
        let conn = db();
        let a = create_note(&conn, "First", "body a", "amber").unwrap();
        let b = create_note(&conn, "", "body b", "jade").unwrap();
        let notes = list_notes(&conn).unwrap();
        assert_eq!(notes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![a, b]);
        assert_eq!(notes[1].title, "");
        assert_eq!(notes[1].color, "jade");
        assert!(!notes[1].pinned);
    }

    #[test]
    fn an_absent_field_is_left_and_an_empty_string_really_empties() {
        let conn = db();
        let id = create_note(&conn, "Named", "body", "amber").unwrap();
        update_note(&conn, id, None, Some("changed".into()), None, None).unwrap();
        let note = &list_notes(&conn).unwrap()[0];
        assert_eq!(note.title, "Named");
        assert_eq!(note.body, "changed");

        update_note(&conn, id, Some(String::new()), None, None, Some(true)).unwrap();
        let note = &list_notes(&conn).unwrap()[0];
        assert_eq!(note.title, "");
        assert!(note.pinned);
    }

    #[test]
    fn a_colour_this_build_has_never_heard_of_is_stored_as_written() {
        let conn = db();
        let id = create_note(&conn, "x", "", "chartreuse").unwrap();
        update_note(&conn, id, None, None, Some("puce".into()), None).unwrap();
        assert_eq!(list_notes(&conn).unwrap()[0].color, "puce");
    }

    #[test]
    fn a_missing_note_is_refused_in_a_sentence() {
        let conn = db();
        assert_eq!(update_note(&conn, 404, None, None, None, None).unwrap_err(), NOTE_GONE);
        assert_eq!(delete_note(&conn, 404).unwrap_err(), NOTE_GONE);
    }

    #[test]
    fn reorder_renumbers_in_the_order_given_and_ignores_a_stranger() {
        let conn = db();
        let a = create_note(&conn, "a", "", "slate").unwrap();
        let b = create_note(&conn, "b", "", "slate").unwrap();
        let c = create_note(&conn, "c", "", "slate").unwrap();
        reorder_notes(&conn, &[c, a, b, 999]).unwrap();
        let notes = list_notes(&conn).unwrap();
        assert_eq!(notes.iter().map(|n| n.id).collect::<Vec<_>>(), vec![c, a, b]);
    }

    #[test]
    fn no_insert_here_names_sync_uid() {
        let source = include_str!("sticky_notes.rs");
        assert!(!source.contains("sync_uid"), "the capture trigger mints it");
    }
}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd src-tauri && cargo test --lib sticky_notes`
Expected: FAIL to compile — `list_notes`, `create_note`, `update_note`, `delete_note`, `reorder_notes`, `NOTE_GONE` not found.

- [ ] **Step 3: Write the module**

Above the test module. Follow `deck_notes.rs`'s file shape: pure functions over `&Connection` first, command wrappers in one `#[cfg(not(target_family = "wasm"))]` block at the foot.

```rust
//! The reader's own prose on the home page — a stack of sticky notes belonging to nobody but
//! them.
//!
//! **A sticky note hangs off nothing**, which is what separates it from `deck_notes`: no
//! parent, no attachment, no scope. Three things `deck_notes.rs` does on every write are
//! therefore absent here and their absence is deliberate — no `touch_deck`, no
//! `deck_audit::record`, no `deck_undo::record_step`. There is no deck to touch.
//!
//! **And no `activity` row.** Not a judgement call: `activity.scope` is
//! `CHECK (scope IN ('collection','wishlist'))`, so there is no word to write.
//!
//! **No INSERT here names `sync_uid`.** The capture trigger mints it, and a test in this file
//! reads this file to keep it that way.

use rusqlite::{Connection, OptionalExtension};

/// The refusal for a note that is not there. A sentence, fired before the transaction opens —
/// never a constraint failure.
pub const NOTE_GONE: &str = "that note is no longer there";

const SELECT: &str = "SELECT id, title, body, color, pinned, sort_order, created_at, updated_at
                      FROM sticky_notes ORDER BY sort_order, id";

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StickyNoteRow {
    pub id: i64,
    pub title: String,
    pub body: String,
    pub color: String,
    pub pinned: bool,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn list_notes(conn: &Connection) -> rusqlite::Result<Vec<StickyNoteRow>> {
    let mut stmt = conn.prepare(SELECT)?;
    let rows = stmt.query_map([], |r| {
        Ok(StickyNoteRow {
            id: r.get(0)?,
            title: r.get(1)?,
            body: r.get(2)?,
            color: r.get(3)?,
            pinned: r.get::<_, i64>(4)? != 0,
            sort_order: r.get(5)?,
            created_at: r.get(6)?,
            updated_at: r.get(7)?,
        })
    })?;
    rows.collect()
}

pub fn create_note(conn: &Connection, title: &str, body: &str, color: &str)
    -> Result<i64, String>
{
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let next: i64 = tx
        .query_row("SELECT coalesce(max(sort_order), -1) + 1 FROM sticky_notes", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    let id: i64 = tx
        .query_row(
            "INSERT INTO sticky_notes (title, body, color, sort_order, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, unixepoch(), unixepoch())
             RETURNING id",
            rusqlite::params![title, body, color, next],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(id)
}

/// Absent means leave it; `Some("")` really empties.
pub fn update_note(
    conn: &Connection,
    id: i64,
    title: Option<String>,
    body: Option<String>,
    color: Option<String>,
    pinned: Option<bool>,
) -> Result<(), String> {
    if !exists(conn, id)? {
        return Err(NOTE_GONE.into());
    }
    conn.execute(
        "UPDATE sticky_notes
            SET title = coalesce(?2, title),
                body = coalesce(?3, body),
                color = coalesce(?4, color),
                pinned = coalesce(?5, pinned),
                updated_at = unixepoch()
          WHERE id = ?1",
        rusqlite::params![id, title, body, color, pinned.map(i64::from)],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_note(conn: &Connection, id: i64) -> Result<(), String> {
    if !exists(conn, id)? {
        return Err(NOTE_GONE.into());
    }
    conn.execute("DELETE FROM sticky_notes WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Renumber in the order given. An id that is not a note is skipped rather than refused — the
/// page sends what it drew, and a note deleted in another window must not fail the drag.
pub fn reorder_notes(conn: &Connection, ids: &[i64]) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    for (i, id) in ids.iter().enumerate() {
        tx.execute(
            "UPDATE sticky_notes SET sort_order = ?2, updated_at = unixepoch() WHERE id = ?1",
            rusqlite::params![id, i as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn exists(conn: &Connection, id: i64) -> Result<bool, String> {
    conn.query_row("SELECT 1 FROM sticky_notes WHERE id = ?1", [id], |_| Ok(()))
        .optional()
        .map(|found| found.is_some())
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd src-tauri && cargo test --lib sticky_notes`
Expected: PASS, six tests.

- [ ] **Step 5: Add the command wrappers**

At the foot of the file, above `mod tests`:

```rust
#[cfg(not(target_family = "wasm"))]
fn unfinished(e: tauri::Error) -> String {
    format!("the note could not be written: {e}")
}

// ⚠️ It is `crate::sync::AppState`, not `crate::AppState` — import it gated, as
// `deck_notes.rs` does: `use crate::sync::{with_write, AppState};`
#[cfg(not(target_family = "wasm"))]
#[tauri::command(async)]
pub fn sticky_notes(state: tauri::State<'_, std::sync::Arc<AppState>>)
    -> Vec<StickyNoteRow>
{
    list_notes(&crate::sync::lock_db_read(state.inner())).unwrap_or_default()
}

#[cfg(not(target_family = "wasm"))]
#[tauri::command]
pub async fn sticky_note_create(
    state: tauri::State<'_, std::sync::Arc<AppState>>,
    title: String,
    body: String,
    color: String,
) -> Result<i64, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        crate::sync::with_write(&state, |conn| create_note(conn, &title, &body, &color))
    })
    .await
    .map_err(unfinished)?
}
```

Write `sticky_note_update`, `sticky_note_delete` and `sticky_note_reorder` to the same shape — `#[tauri::command] pub async fn`, clone the state, `spawn_blocking`, `crate::sync::with_write`, `.map_err(unfinished)?`.

⚠️ The read is `#[tauri::command(async)]` on a **sync** `fn` and is infallible by signature: it takes `lock_db_read`'s mutex and is called while the window draws its first frame. The writes go through `with_write`, which answers `crate::db::BUSY` if a sync holds the connection.

- [ ] **Step 6: Register in all three places**

⚠️ **A command missing from one of them answers `unknown command` at runtime with nothing red.**

1. `src-tauri/src/lib.rs` — `pub mod sticky_notes;` in the "Every target" block, beside `pub mod deck_notes;`. The module must compile for `wasm32-unknown-unknown`; the commands are gated, the module is not.
2. `src-tauri/src/desktop.rs` — all five in `generate_handler!`, beside `home::home_layout`.
3. `src-tauri/src/web/route.rs` — all five in the `COMMANDS` array **and** a `match` arm each.

⚠️ **`every_advertised_command_is_actually_routed` asserts `COMMANDS.len()`** — another written-down number, 172 → **177**. Count the array literal rather than adding five to 172; the arithmetic happening to agree does not make it read.

⚠️ **`desktop.rs`'s `use crate::{…}` list needs `sticky_notes` too**, in sorted position — without it the `sticky_notes::` paths in `generate_handler!` do not resolve, and the error points at the macro rather than at the import.

The read arm:

```rust
        "sticky_notes" => {
            let conn = crate::sync::lock_db_read(state);
            encode(command, crate::sticky_notes::list_notes(&conn).unwrap_or_default())
        }
```

and a write arm, on `set_home_layout`'s model:

```rust
        "sticky_note_create" => {
            let title: String = field(command, args, "title")?;
            let body: String = field(command, args, "body")?;
            let color: String = field(command, args, "color")?;
            encode(
                command,
                crate::sync::with_write(state, |c| {
                    crate::sticky_notes::create_note(c, &title, &body, &color)
                })
                .map_err(RouteError::Failed)?,
            )
        }
```

- [ ] **Step 7: Verify it compiles on both targets**

Run: `cd src-tauri && cargo check --lib && cargo check --lib --target wasm32-unknown-unknown`
Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add src-tauri/src/sticky_notes.rs src-tauri/src/lib.rs src-tauri/src/desktop.rs src-tauri/src/web/route.rs && git commit -m "feat(notes): add the five sticky-note commands"
```

---

## Task 4: The IPC surface and the two table registries

**Files:**
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/userTables.json`, `src/lib/crossWindow.ts` (+ its test)

**Interfaces:**
- Consumes: task 3's five command names and their argument names.
- Produces: `StickyNote`, `StickyNotePatch` and `ipc.stickyNotes` / `stickyNoteCreate` / `stickyNoteUpdate` / `stickyNoteDelete` / `stickyNoteReorder`. Tasks 6, 7, 9 and 11 all consume them.

- [ ] **Step 1: Write the failing contract test**

⚠️ `src/lib/ipc.test.ts` is the **opt-in** fence that catches Rust↔`ipc.ts` drift; a `vi.fn()` mock erases the mirror, so a field missing here fails at runtime rather than at `tsc`. Add the five commands to its table in the shape the file already uses.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/lib/ipc.test.ts`
Expected: FAIL — the five bindings do not exist.

- [ ] **Step 3: Add the types and the bindings**

The `StickyNote` and `StickyNotePatch` interfaces exactly as in **Shared vocabulary** above, then:

```ts
  stickyNotes: (): Promise<StickyNote[]> => invoke("sticky_notes"),
  stickyNoteCreate: (title: string, body: string, color: string): Promise<number> =>
    invoke("sticky_note_create", { title, body, color }),
  stickyNoteUpdate: (id: number, patch: StickyNotePatch): Promise<void> =>
    invoke("sticky_note_update", { id, ...patch }),
  stickyNoteDelete: (id: number): Promise<void> => invoke("sticky_note_delete", { id }),
  stickyNoteReorder: (ids: number[]): Promise<void> => invoke("sticky_note_reorder", { ids }),
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:run -- src/lib/ipc.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the table to both multi-window registries**

`src/lib/userTables.json` gains `"sticky_notes"` in its sorted position — a **Rust** test asserts this file equals the user side of `schema::TABLES`, so it is red until this lands.

`src/lib/crossWindow.ts` gains the map entry — a **Vitest** test asserts the map's keys equal that file:

```ts
  sticky_notes: [["stickyNotes"]],
```

⚠️ Checked against `multi-window.md`'s refresh-loop rule: a query whose command *writes* the table its own key reads loops for ever. None of the five commands writes on read, so this table maps normally.

- [ ] **Step 6: Run the map's test**

Run: `npm run test:run -- src/lib/crossWindow.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib && git commit -m "feat(ipc): bind the sticky-note commands and register the table"
```

---

## Task 5: The `--color-note-*` family

**Files:**
- Modify: `src/index.css` — inside `@theme`, after the rarity block at :393

**Interfaces:**
- Consumes: nothing.
- Produces: `--color-note-amber` / `-jade` / `-azure` / `-rose` / `-slate`, each with a `-strip` twin, plus `--color-note-dim`. Tasks 8 and 9 read them.

- [ ] **Step 1: Add the family**

After the rarity block, **outside** the pie deeps — the theory marks at :385 are the precedent and their comment states the reason:

```css
  /* The five sticky-note fills (user schema v46). Deliberately low chroma and placed outside
     the pie deeps: a note's colour is the reader's own filing and carries no meaning the app
     reads, so it must not be mistaken for a sixth identity colour or out-shout a mana pip.
     Surfaces sit at L 26% against `--color-surface`'s 21%, so a note reads as paper raised
     off the panel; the strip is the 3px edge across its top. */
  --color-note-amber: oklch(0.26 0.04 85);
  --color-note-amber-strip: oklch(0.62 0.1 85);
  --color-note-jade: oklch(0.26 0.04 155);
  --color-note-jade-strip: oklch(0.6 0.1 155);
  --color-note-azure: oklch(0.26 0.04 250);
  --color-note-azure-strip: oklch(0.62 0.1 250);
  --color-note-rose: oklch(0.26 0.04 20);
  --color-note-rose-strip: oklch(0.62 0.11 20);
  --color-note-slate: oklch(0.26 0.008 270);
  --color-note-slate-strip: oklch(0.55 0.015 270);
  /* Secondary text ON a note. `--color-dim` measures about 4.3:1 against these L 26% fills,
     under the 4.5:1 floor, so it is a contrast bug no test catches. `text-dim` stays correct
     on the page background. */
  --color-note-dim: oklch(0.73 0.012 90);
```

- [ ] **Step 2: Run the token sweep to verify nothing broke**

Run: `npm run test:run -- src/lib/tokens.test.ts`
Expected: PASS. That file enumerates no tokens — its two colour assertions are about the `dim`/`muted` rename — so a new family goes green.

- [ ] **Step 3: Commit**

```bash
git add src/index.css && git commit -m "feat(tokens): add the sticky-note colour family"
```

---

## Task 6: The derivations

**Files:**
- Create: `src/features/home/stickyNotes.ts`, `src/features/home/stickyNotes.test.ts`

**Interfaces:**
- Consumes: `StickyNote` from `@/lib/ipc` (task 4); `noteToPlainText` from `@/features/decks/noteMarkdown`.
- Produces: `NOTE_COLORS`, `NoteColor`, `UNTITLED_STICKY`, `noteColor(stored: string): NoteColor`, `stickyTitle(note: Pick<StickyNote, "title" | "body">): string`, `notePreview(body: string, lines: number): string`, `orderedNotes(notes: StickyNote[], pinnedFirst: boolean): StickyNote[]`. Tasks 8 and 9 consume all of them.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";

import { noteColor, notePreview, orderedNotes, stickyTitle, UNTITLED_STICKY } from "./stickyNotes";

const note = (over: Partial<Parameters<typeof orderedNotes>[0][number]> = {}) => ({
  id: 1, title: "", body: "", color: "slate", pinned: false,
  sortOrder: 0, createdAt: 0, updatedAt: 0, ...over,
});

describe("noteColor", () => {
  it("keeps a colour this build knows", () => {
    expect(noteColor("amber")).toBe("amber");
  });

  // The whole point of the column carrying no CHECK: a newer build's word arrives over sync
  // and must draw as something rather than fail.
  it("reads a colour it has never heard of as slate", () => {
    expect(noteColor("puce")).toBe("slate");
    expect(noteColor("")).toBe("slate");
  });
});

describe("stickyTitle", () => {
  it("is the title when there is one", () => {
    expect(stickyTitle({ title: "Trade night", body: "# Heading" })).toBe("Trade night");
  });

  it("is the body's first line when there is not", () => {
    expect(stickyTitle({ title: "", body: "# Bring the binder\n\nand the box" }))
      .toBe("Bring the binder");
  });

  it("is the placeholder when there is neither", () => {
    expect(stickyTitle({ title: "", body: "   " })).toBe(UNTITLED_STICKY);
  });
});

describe("notePreview", () => {
  it("drops blank lines and clamps to the count", () => {
    expect(notePreview("one\n\ntwo\n\nthree", 2)).toBe("one\ntwo");
  });

  // ⚠️ The behaviour a tile author will get wrong: `joinRuns` joins wrapped source lines with
  // a space, so a long paragraph is ONE entry here however many rows it draws.
  it("counts blocks and list items, never visual lines", () => {
    const wrapped = "a very long paragraph\nthat wrapped in the source";
    expect(notePreview(wrapped, 1)).toBe("a very long paragraph that wrapped in the source");
  });

  it("is empty for an empty body", () => {
    expect(notePreview("   ", 3)).toBe("");
  });
});

describe("orderedNotes", () => {
  const a = note({ id: 1, sortOrder: 0 });
  const b = note({ id: 2, sortOrder: 1, pinned: true });
  const c = note({ id: 3, sortOrder: 2 });

  it("is sort order when pinning is off", () => {
    expect(orderedNotes([c, b, a], false).map((n) => n.id)).toEqual([1, 2, 3]);
  });

  it("lifts the pinned note and keeps the rest in order", () => {
    expect(orderedNotes([c, b, a], true).map((n) => n.id)).toEqual([2, 1, 3]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:run -- src/features/home/stickyNotes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
/**
 * What a sticky note *is*, computed — the page's half of the boundary.
 *
 * Rust stores strings and validates nothing about a colour, deliberately: `sticky_notes` is
 * synced, and a CHECK there would make a build that adds a sixth colour emit rows this build
 * refuses at apply. So an unknown word reads as `slate` here, which is `widgets.ts`' existing
 * rule for a stored value no option carries.
 */
import { noteToPlainText } from "@/features/decks/noteMarkdown";
import type { StickyNote } from "@/lib/ipc";

export const NOTE_COLORS = ["amber", "jade", "azure", "rose", "slate"] as const;
export type NoteColor = (typeof NOTE_COLORS)[number];

/** What a note with neither a title nor a body is called. */
export const UNTITLED_STICKY = "Untitled note";

export function noteColor(stored: string): NoteColor {
  return (NOTE_COLORS as readonly string[]).includes(stored)
    ? (stored as NoteColor)
    : "slate";
}

/** The title, or the body's first line, or the placeholder — computed, never stored. */
export function stickyTitle(note: Pick<StickyNote, "title" | "body">): string {
  if (note.title !== "") return note.title;
  const [first = ""] = noteToPlainText(note.body).split("\n");
  return first === "" ? UNTITLED_STICKY : first;
}

/**
 * The first `lines` non-empty lines of a body, as words.
 *
 * ⚠️ **`lines` counts blocks and list items, not visual lines.** `noteToPlainText` joins
 * wrapped source lines with a space, so one long paragraph is a single very long entry and a
 * tile still needs its own character clamp on top of this.
 */
export function notePreview(body: string, lines: number): string {
  return noteToPlainText(body)
    .split("\n")
    .filter((line) => line !== "")
    .slice(0, lines)
    .join("\n");
}

/** Sort order, with pinned notes lifted when the widget's toggle is on. */
export function orderedNotes(notes: StickyNote[], pinnedFirst: boolean): StickyNote[] {
  const by = [...notes].sort((l, r) => l.sortOrder - r.sortOrder || l.id - r.id);
  if (!pinnedFirst) return by;
  return [...by.filter((n) => n.pinned), ...by.filter((n) => !n.pinned)];
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run test:run -- src/features/home/stickyNotes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/features/home/stickyNotes.ts src/features/home/stickyNotes.test.ts && git commit -m "feat(home): add the sticky-note derivations"
```

---

## Task 7: The query key and the data layer

**Files:**
- Create: `src/features/home/useStickyNotes.ts`
- Modify: `src/features/home/keys.ts`, `src/features/home/keys.test.tsx`

**Interfaces:**
- Consumes: task 4's `ipc.stickyNotes` and the four writes; `StickyNote`, `StickyNotePatch`.
- Produces: `stickyNotesKey: QueryKey` and `useStickyNotes(): StickyNotesApi` with the fields below. Tasks 8 and 9 consume them.

```ts
export interface StickyNotesApi {
  notes: StickyNote[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  create: (title: string, body: string, color: NoteColor) => void;
  update: (id: number, patch: StickyNotePatch) => void;
  remove: (id: number) => void;
  reorder: (ids: number[]) => void;
}
```

- [ ] **Step 1: Add the key**

In `src/features/home/keys.ts`, with the module's own rule quoted in a comment — a key sits under the root its data already lives under, and this data lives nowhere else yet, so it is its own root:

```ts
/** Every sticky note. Its own root: no other query reads this table, and `crossWindow.ts`
 *  maps `sticky_notes` to exactly this key. */
export const stickyNotesKey: QueryKey = ["stickyNotes"];
```

Add it to whatever exhaustive list `keys.test.tsx` holds.

- [ ] **Step 2: Run the key test**

Run: `npm run test:run -- src/features/home/keys.test.tsx`
Expected: PASS.

- [ ] **Step 3: Write the hook**

```ts
/**
 * Every sticky note, and the four writes.
 *
 * One query and one invalidation: the table is small, every write changes the list's order or
 * its contents, and `crossWindow.ts` re-reads the same key in the other window.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { ipc, type StickyNote, type StickyNotePatch } from "@/lib/ipc";

import { stickyNotesKey } from "./keys";
import type { NoteColor } from "./stickyNotes";

export interface StickyNotesApi { /* as declared in Interfaces above */ }

export function useStickyNotes(): StickyNotesApi {
  const queryClient = useQueryClient();
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: stickyNotesKey });
  };

  const query = useQuery({ queryKey: stickyNotesKey, queryFn: () => ipc.stickyNotes() });

  const create = useMutation({
    mutationFn: ({ title, body, color }: { title: string; body: string; color: NoteColor }) =>
      ipc.stickyNoteCreate(title, body, color),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: StickyNotePatch }) =>
      ipc.stickyNoteUpdate(id, patch),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: number) => ipc.stickyNoteDelete(id),
    onSuccess: invalidate,
  });
  const reorder = useMutation({
    mutationFn: (ids: number[]) => ipc.stickyNoteReorder(ids),
    onSuccess: invalidate,
  });

  return {
    notes: query.data ?? [],
    isPending: query.isPending,
    isError: query.isError,
    error: query.error,
    create: (title, body, color) => create.mutate({ title, body, color }),
    update: (id, patch) => update.mutate({ id, patch }),
    remove: (id) => remove.mutate(id),
    reorder: (ids) => reorder.mutate(ids),
  };
}
```

- [ ] **Step 4: Verify it type-checks**

Run: `npx tsc --noEmit`
Expected: clean. ⚠️ IDE diagnostics are stale mid-write; `tsc --noEmit` is the authority.

- [ ] **Step 5: Commit**

```bash
git add src/features/home/useStickyNotes.ts src/features/home/keys.ts src/features/home/keys.test.tsx && git commit -m "feat(home): add the sticky-note query and writes"
```

---

## Task 8: The editor dialog

**Files:**
- Create: `src/features/home/StickyNoteDialog.tsx`, `src/features/home/StickyNoteDialog.stories.tsx`

**Interfaces:**
- Consumes: task 6's `NOTE_COLORS`, `NoteColor`, `noteColor`; task 4's `StickyNote`, `StickyNotePatch`.
- Produces:

```tsx
export function StickyNoteDialog({ note, onSave, onDelete, onClose }: {
  note: StickyNote;
  onSave: (patch: StickyNotePatch) => void;
  onDelete: () => void;
  onClose: () => void;
}): ReactElement
```

Task 9 mounts it.

- [ ] **Step 1: Write the dialog**

Copy `DeckNotesPanel.tsx:997`'s lazy mount exactly — **this is the one line the repo-wide sweep is watching**:

```tsx
const NoteEditor = lazy(() => import("@/features/decks/NoteEditor"));
```

and the fallback is a sentence rather than a spinner, because the chunk arrives off local disk:

```tsx
<Suspense fallback={<p className="text-[0.6875rem] text-dim">Opening the editor…</p>}>
  <NoteEditor value={draftBody} onChange={setDraftBody} ariaLabel={`Body of ${title}`} />
</Suspense>
```

The panel holds a name `<input>` (label "Name"), the five colour swatches as `<button>`s with `aria-label`s, the editor, and a footer row of a saved indicator and a Delete note button. Draw it to the **Writing a note** artboard.

⚠️ **This is a `fixed` overlay mounted inside the widget body, and it is legal only because the home page has no containment.** `fit.ts:15` and `HomePage.tsx` both say so: there is no `container-type` anywhere on this page, deliberately, because `@container` makes a box the containing block for every `fixed` descendant. Do not add one.

- [ ] **Step 2: Write the debounced autosave**

This is the only new interaction in the feature and nothing in the codebase does it today. `DeckNotesPanel` is an explicit Save with no debounce and no unsaved-change guard, which loses prose when a dashboard dialog closes on a scrim press.

Derive a **partial** patch — only the fields that differ from the row — and debounce writing it.

⚠️ **Three ways the obvious version of this is wrong, each of which shipped in an earlier draft of this plan:**

- **Never send `color` unless a swatch was actually pressed.** The only way to seed a colour draft is `noteColor(note.color)`, which maps an unknown word to `slate` — so opening a note whose colour a *newer* build wrote and typing one letter would silently repaint it, defeating the reason the column carries no CHECK. Keep the pick `null` until pressed, and compare against the **stored string**, not against the mapped value.
- **Never put `note` or `onSave` in the dependency array.** `useStickyNotes` invalidates on every write, so a fresh object identity restarts the debounce — starving the timer for as long as the reader keeps typing. Depend on the derived patch's primitives and latch `onSave` in a ref.
- **Send a partial.** `coalesce(?n, col)` at the far end is what makes that legal; sending all three fields every time throws away the distinction between "unchanged" and "set to this".

The flush is a mount-only cleanup — `useEffect(() => () => void write(), [write])` with `write` a `useCallback(…, [])` over refs, which is the only reason it runs once at unmount rather than per keystroke. `write` dedupes on the patch JSON so a close inside a round trip does not write twice, and **forces past that dedupe when `writeError` is set**, or a refused write is recorded as sent and the retry is skipped too.

⚠️ **`Date.now()` in a component body is a hard lint error here** (`react-hooks/purity`) — green `tsc`, green vitest, red only at `verify`. Take it as a default parameter (`nowMs: number = Date.now()`), which is `BackupPanel`'s shape.

⚠️ **Flush on unmount as well**, or the last keystrokes before a close are lost — which is the failure this whole section exists to avoid. Keep the pending draft in a ref and write it in the cleanup of a mount-only effect.

⚠️ **No `setState` inside an effect body.** The derived-state sync is a cascading-renders lint failure this repo has paid for twice; it passes `tsc` and vitest and dies only at `verify`.

- [ ] **Step 3: Write the stories**

`title: "Home/StickyNoteDialog"`. Cover: a note being edited, an empty note, each colour selected. ⚠️ Stories run in a real browser, so the lazy chunk actually loads — that is the point of having them.

- [ ] **Step 4: Verify it type-checks and the sweep is still green**

Run: `npx tsc --noEmit && npm run test:run -- src/features/decks/DeckNotesPanel.test.tsx`
Expected: clean, and the editor's "is reached by nothing but a dynamic import" test passes.

- [ ] **Step 5: Commit**

```bash
git add src/features/home/StickyNoteDialog.tsx src/features/home/StickyNoteDialog.stories.tsx && git commit -m "feat(home): add the sticky-note editor dialog"
```

---

## Task 9: The widget body

**Files:**
- Create: `src/features/home/widgets/StickyNotesWidget.tsx`, `StickyNotesWidget.test.tsx`, `StickyNotesWidget.stories.tsx`

**Interfaces:**
- Consumes: `WidgetBodyProps` from `../widgetProps`; task 6's derivations; task 7's `useStickyNotes`; task 8's `StickyNoteDialog`; `pickOf` / `toggleOn` from `../widgetSettings`; `WidgetMessage` from `../WidgetParts`; `fit.fitCount`.
- Produces: `export function StickyNotesWidget(props: WidgetBodyProps): ReactElement`. Task 10 imports it by that name.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("StickyNotesWidget", () => {
  it("draws the Board by default and the Pad when the pick says so", () => { /* … */ });

  it("cuts tiles to whole rows and draws none rather than one it clips", () => {
    // fit.fitCount's zero is a real answer — assert an empty tile list at a height that
    // fits none, NOT a single clipped tile.
  });

  it("reads a colour it has never heard of as slate", () => { /* … */ });

  it("says so when there are no notes", () => { /* … */ });

  it("opens no dialog and mounts no editor while still", () => {
    // `still` is a catalogue preview: it must not load a 141.5 kB chunk to draw a thumbnail.
  });

  it("names the note's own words in the accessible name of its press", () => {
    // Assert the COMPUTED accessible name, never the parts — a CSS gap is not a word
    // separator to name computation.
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:run -- src/features/home/widgets/StickyNotesWidget.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the body**

Read the spec's §7 and the artboards before starting. The shape:

```tsx
export function StickyNotesWidget({ widget, fit, editing, still }: WidgetBodyProps) {
  const layout = String(pickOf(widget, "layout") ?? "board");
  const dates = toggleOn(widget, "dates");
  const strip = toggleOn(widget, "strip");
  const pinnedFirst = toggleOn(widget, "pinned");
  const notes = useStickyNotes();

  if (notes.isPending) return <WidgetMessage>{PENDING}</WidgetMessage>;
  if (notes.isError) {
    return (
      <WidgetMessage tone="destructive">
        Could not read your notes — {ipcError(notes.error)}
      </WidgetMessage>
    );
  }

  const ordered = orderedNotes(notes.notes, pinnedFirst);
  if (ordered.length === 0) return <EmptyNotes still={still} onNew={…} />;

  return layout === "pad"
    ? <Pad notes={ordered} fit={fit} … />
    : <Board notes={ordered} fit={fit} … />;
}
```

**Board.** Tiles in a grid; columns from the body's width, not from cells:

```tsx
/** Two at 2×2, three at 4×3, four at 6×3 — the artboards are the target and a live pass
 *  settles whether 4×2 wants three or four. */
export function tileColumns(bodyWidthPx: number): number {
  return Math.max(2, Math.min(4, Math.floor(bodyWidthPx / 115)));
}
```

Each tile: the note's fill inline from `var(--color-note-<colour>)`, a 3 px strip in
`var(--color-note-<colour>-strip)` when `strip` is on, `stickyTitle(note)` in the display face,
`notePreview(note.body, 4)` in `var(--color-note-dim)`, a 6 px gold dot when pinned, and the
edited date when `dates` is on. ⚠️ **Inline from the custom property, never a Tailwind class.**

**Pad.** One note at full size with sheets behind, and the other notes carried by `fit.tier`:
pager at 0–1, a horizontal name rail at 2, a vertical rail at 3. Which note shows is
`useState`, seeded to the pinned note if there is one and the first otherwise — **never stored.**

⚠️ **Set `whitespace-pre-line`** on the block container that renders `parseNoteBody`'s output.
⚠️ **`--color-note-dim` for secondary text on a note, `text-dim` on the page background.**

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run test:run -- src/features/home/widgets/StickyNotesWidget.test.tsx`
Expected: PASS.

- [ ] **Step 5: Write the stories**

`title: "Home/StickyNotesWidget"`, on `RecentCardsWidget.stories.tsx`'s `Framed` template (a local `CELL = 104`, **not exported** — CSF indexes every non-default export as a story). Cover: Board at 2×2, 4×3 and 6×3; Pad at the same three; both empty; `Still`.

- [ ] **Step 6: Commit**

```bash
git add src/features/home/widgets/StickyNotesWidget.tsx src/features/home/widgets/StickyNotesWidget.test.tsx src/features/home/widgets/StickyNotesWidget.stories.tsx && git commit -m "feat(home): draw the sticky-notes widget"
```

---

## Task 10: The registry row and the page's switch

**Files:**
- Modify: `src/features/home/widgets.ts`, `widgets.test.ts`, `HomePage.tsx`, `HomePage.test.tsx`

**Interfaces:**
- Consumes: task 9's `StickyNotesWidget`.
- Produces: the kind `"stickyNotes"` — the last thing the feature needs to be reachable.

- [ ] **Step 1: Write the failing registry test**

In `widgets.test.ts`, add `stickyNotes: true` to `EVERY_KIND` (:24) and the entry to the pinned-vocabulary object (:148) — **every key and option id there is a word already written into readers' `config` rows**:

```ts
      stickyNotes: {
        picks: { layout: { ids: ["board", "pad"], dflt: undefined } },
        toggles: ["dates", "strip", "pinned"],
        chip: "layout",
      },
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:run -- src/features/home/widgets.test.ts`
Expected: FAIL — `tsc` errors on `EVERY_KIND`, because `WidgetKind` has no `stickyNotes` member.

- [ ] **Step 3: Add the union member and the meta row**

`| "stickyNotes"` on `WidgetKind`, and the row in `WIDGET_META` **exactly as the spec's §7 gives it**. Insertion order in that object is the catalogue's order; put it last.

⚠️ `RESERVED_KEYS = ["title", "density"]` — no pick or toggle here may use either.
⚠️ Every toggle defaults **on** (`WidgetToggle` is stored only as `false`); all three are written to be correct that way round.
⚠️ `DEFAULT_LAYOUT` does **not** change — the kind is catalogue-only, so none of its three copies (`widgets.ts`, `home.rs`, `.storybook/fake/db.ts:2623`) moves.

- [ ] **Step 4: Wire the page's switch**

In `HomePage.tsx`, the import beside the other nine (:87) and the case in `renderBody` (:177):

```tsx
    case "stickyNotes":
      return <StickyNotesWidget {...props} />;
```

`renderExtraSettings` needs no case — every setting is a registry row.

In `HomePage.test.tsx`, the tenth `vi.mock` (:42):

```ts
vi.mock("./widgets/StickyNotesWidget", () => ({ StickyNotesWidget: stubs.body }));
```

- [ ] **Step 5: Run both test files to verify they pass**

Run: `npm run test:run -- src/features/home/widgets.test.ts src/features/home/HomePage.test.tsx`
Expected: PASS. The generic sweeps in `widgets.test.ts` now enforce the new row for free — non-empty words, `def` inside `min..max`, `def[0] <= 8`, unique pick keys avoiding the reserved ones, and `chip` naming a real pick.

- [ ] **Step 6: Commit**

```bash
git add src/features/home/widgets.ts src/features/home/widgets.test.ts src/features/home/HomePage.tsx src/features/home/HomePage.test.tsx && git commit -m "feat(home): register the sticky-notes widget kind"
```

---

## Task 11: The Storybook fake

**Files:**
- Modify: `.storybook/fake/db.ts`, `.storybook/fake/seeds.ts`, `.storybook/fake/db.test.ts`

**Interfaces:**
- Consumes: task 4's command names and `StickyNote`.
- Produces: a `stickyNotes: StickyNote[]` field on `FakeDb`, seeded, with one read handler and four write handlers. Tasks 8, 9 and the page's stories all read it.

- [ ] **Step 1: Add the field and the seed**

`stickyNotes: StickyNote[]` on `FakeDb`, beside `recentCards` (:1833). Seed the `starter` world with the artboards' notes — Trade night (amber, pinned), Bracket 3 (jade), Cards to proxy (azure), Sealed box math (slate), Wishlist (rose), Sleeve stock (slate), Draft archetypes (jade), Deck ideas (azure). The `empty` world gets none.

⚠️ Give at least one seeded body a **hard break** and at least one a bullet list, so a renderer that forgets `whitespace-pre-line` is visible in Storybook rather than only in the shipped window.

- [ ] **Step 2: Add the handlers**

`readHandlers.sticky_notes` beside `recent_cards` (:10631), and four `writeHandlers` beside `set_home_layout` (:18197). The writes go through `refuseIfBusy`, which is what makes the `busy` world reach this widget's refusal — ⚠️ the **read** refusal stays unstoryable, which is the gap `home-page.md:507` already records for six other widgets. Do not add a fault to chase it.

- [ ] **Step 3: Add the db test cases**

In `db.test.ts`, on the pattern the other handlers use: a create lands last, an update patches, a delete removes, a reorder renumbers.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm run test:run -- .storybook/fake/db.test.ts`
Expected: PASS.

⚠️ **`grep` calls this file binary** — a stray NUL in it makes "no matches" a lie. Use `grep -a` if you search it.

- [ ] **Step 5: Commit**

```bash
git add .storybook/fake && git commit -m "test(storybook): serve sticky notes from the fake"
```

---

## Task 12: Fan-in — the docs, and verify

**Run by the coordinator, after every other task has landed.**

**Files:**
- Modify: `docs/reference/home-page.md`, `docs/reference/data-and-sync.md`, `docs/reference/sync.md`, `src/features/home/CLAUDE.md` if one exists else `src/CLAUDE.md`, `CLAUDE.md`

- [ ] **Step 1: Update `docs/reference/home-page.md`**

§3's heading is "The nine widgets" and becomes ten; its table gains a row:

| `kind` | draws | `config` |
| --- | --- | --- |
| `stickyNotes` | the reader's own notes, as a board of tinted tiles or a pad of stacked sheets | `{ layout: board·pad, dates, strip, pinned }` |

§5's "It is not synced, and that is an asymmetry rather than an oversight" gains a sentence: `activity` is still unsynced, and `sticky_notes` — the other user-authored table this page now reads — **is**, so the asymmetry is now inside one page.

- [ ] **Step 2: Update the sync and schema docs**

`docs/reference/sync.md` — the fifteen synced tables become sixteen, and the row-naming section gains `sticky_notes` as the first synced table with no parent.
`docs/reference/data-and-sync.md` — the schema ladder gains rung 46.

⚠️ **Re-count every list you touch in the same commit.** A prose-only edit routes to neither CI job, so nothing goes red when a document rots, and counts in these files have each drifted at least once.

- [ ] **Step 3: Update `CLAUDE.md`'s vocabulary paragraph**

The root `CLAUDE.md` already pins *tag* versus *label* versus the collection's `tags` column. Add the same treatment for *notes*, naming all four things now spelled that way — deck note, card note, entry note, sticky note.

- [ ] **Step 4: Run the whole suite, once**

```bash
npm run verify
```

⚠️ **Never run two verifies at once** — concurrent runs fake around eighteen Rust schema failures. ⚠️ **Do not pipe it** — `| tail` reports tail's exit 0 while tests fail. ⚠️ `verify` runs neither `cargo fmt` nor `clippy`, and CI runs both; run them separately before pushing.

- [ ] **Step 5: Drive the real window**

Every UI task in Plans 2–3 found something the suite could not. Add the widget from the catalogue, write a note, change its colour, flip to Pad, resize through 2×2 → 8×6, and check the empty state. `docs/reference/live-ui-verification.md` is the contract.

⚠️ Take the `app` lock first — one app across every worktree, and the collision is silent.

- [ ] **Step 6: Commit and ship**

Follow the `shipping-a-branch` skill: `npm run verify` → PR → merge `main` in (never rebase) → wait for `ci-ok`. The agent does not press Merge.

---

## Self-review

**Spec coverage.** §2's vocabulary → task 12 step 3. §2's config refusal → argued in the spec, no task needed. §3's rung → task 1. §3's no-CHECK → task 1 step 4 and task 6's test. §3's colours → task 5. §3's contrast floor → Global Constraints and task 9. §4's ten sites → tasks 1 and 2. §4's two multi-window sites → task 4. §5's commands → task 3. §5's derivations → task 6. §6's editor and autosave → task 8. §6's two fences → task 9. §7's registry row → task 10. §8's testing → each task's own steps plus task 12.

**Known thin spots, stated rather than hidden.** Task 9's Board and Pad steps give the structure, the column formula and every fence, but not a complete component body — the artboards are the specification for its appearance and a reviewer should compare against them rather than against pasted JSX. Task 8's autosave gives the effect and the flush-on-unmount warning but not the whole dialog. Both are the two tasks where the design, not the plan, is the source of truth; every other task carries its code in full.

**Type consistency.** `StickyNoteRow` (Rust) ↔ `StickyNote` (TS) field-for-field with `sort_order`/`sortOrder` bridged by `#[serde(rename_all = "camelCase")]`. `StickyNotePatch` is the same four optional fields in task 3's `update_note`, task 4's binding and task 7's mutation. `NoteColor` is task 6's and is consumed unchanged by 7, 8 and 9. `stickyNotesKey` is task 7's and is the exact value task 4 maps `sticky_notes` to in `crossWindow.ts`.
