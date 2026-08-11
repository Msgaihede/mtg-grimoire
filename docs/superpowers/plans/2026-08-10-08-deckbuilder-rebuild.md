# Deck Builder Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Replace the zone-based deck editor with a visual-first, category-grouped deck builder —
card stacks, four views, per-deck tags, rule-violation marking, an audit log, Live/Theory decks and
folder-organised deck storage.

**Architecture:** `deck_cards.zone` is **removed** and replaced by `deck_cards.category_id`. A
`deck_categories` row carries a `kind` (`main | side | commander | companion | maybe`) — that kind is
what the rules read, so the validation engine, the allocator and `format_specs` keep working
unchanged in substance while gaining a user-facing name, an active flag and a sort order. A category
whose `is_active` is 0 counts toward **nothing** — which is exactly what `maybe` meant before, so the
scratchpad stops being a special case and becomes the one predefined category seeded inactive.
Everything else is additive: `deck_folders`, `deck_tags`, `deck_audit`, and a `variant`
(`live | theory`) column that widens the deck-card grain.

**Tech Stack:** Rust (rusqlite/SQLite, Tauri 2.11) · React 19 + TypeScript 6 · TanStack Query ·
Tailwind v4 · pragmatic-drag-and-drop · Vitest · Storybook 9.

---

## Global Constraints

Every task's requirements implicitly include this section. Read `CLAUDE.md` before starting; these
are the rules it states that this plan touches most.

- **Work is committed small**, one commit per task, `feat:`/`fix:`/`chore:`/`test:` prefixes.
  Never type a version number — release-please owns all five version files.
- **`npm run verify` must pass** before a task is called done (build + lint + Vitest + `cargo test`).
- **Rust owns data plumbing; TS owns domain logic.** Validation, grouping, sorting, auto-category
  derivation and audit-sentence rendering are TypeScript. Rust supplies facts.
- **Nothing may declare `REFERENCES cards(id)`.** `cards` is dropped and recreated on every sync;
  a declared FK there aborts every sync. Card ids in user tables are **soft** references with
  `set_code`/`collector_number`/`lang`/`name` denormalised beside them.
- **Enforced foreign keys are user↔user only, and every one is a deliberate `ON DELETE` choice.**
  This plan adds several; each states its reasoning in the DDL comment.
- **`CARDS_COLUMNS` is frozen.** New `cards` columns go in a new `if v < N` step. This plan adds
  none.
- **`raw` is a gzip BLOB.** Any migration reading it goes through `schema::json_raw`, guard wrapping
  the *argument*, never as a `WHERE` term. This plan reads it nowhere.
- **A migration that renumbers `cards` rowids or touches `name`/`type_line`/`search_text` owes
  `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');`.** This plan touches only user tables, so it
  owes none — and each new step must carry the test that proves it (`the_v8_step_leaves_the_search_index_answering`).
- **Writes take `AppState.db` through `db::lock_for(…, WRITE_LOCK_WAIT)` and answer
  `collection::BUSY`; reads go through `AppState.db_read`.**
- **Dim text is `text-dim`, never `text-muted`.** Z-indexes come from `LAYER` in `src/lib/layers.ts`
  and nowhere else — `src/lib/layers.test.ts` sweeps `src/` to enforce it. Tailwind scans source
  text for whole class names, so a class built by interpolation emits no rule: variant spellings are
  written out.
- **Card art is drawn with `components/CardImage`, never a bare `<img>`.**
- **Escape closes one layer per press**: inner layers listen on `window` in the **capture** phase and
  `preventDefault()`; outer ones listen in the bubble phase and return early on `e.defaultPrevented`.
  Use `useDismissOnEscape`. Two `"inner"` peers must never be open at once — model them as one piece
  of state.
- **Mana and set symbols come from the bundled `mana-font`/`keyrune` packages** through `ManaText` /
  `RarityGem`, never a CDN and never a hand-drawn pip.
- **Prices:** a deck card's unit price is the **nonfoil `usd`** key of that printing's `prices` blob.
  `cards.price_usd` is a display fallback chain and is never summed. A price is never shown without
  `PRICES_AS_OF` somewhere on the surface.
- **Storybook:** every new component gets a story file; a story file that writes `useAppStore` during
  render needs `docs: { story: { inline: false, height } }`. Fixtures shared by more than one story
  file live in `.storybook/fake/fixtures.ts`. `@types/node` must never be installed.
- **Design source of truth:** `docs/superpowers/specs/2026-08-04-visual-design-direction.md` and the
  imported canvas at `claude.ai/design/p/f6dac504-6f67-49fc-9807-2157ab0c9189`
  (`Deck Builder.dc.html`). Implementers execute that direction; they do not invent their own.

### Vocabulary this plan fixes

| Term | Meaning |
|---|---|
| **category** | A named, ordered, active-or-inactive bucket of deck cards. Replaces the zone. |
| **kind** | A category's rules role: `main` \| `side` \| `commander` \| `companion` \| `maybe`. A user-made category is always `main`. |
| **predefined category** | One per non-`main` kind per deck. Auto-created, name and kind not editable, `is_active` still is. |
| **group** | What a view draws. Under *Categories* grouping a group **is** a category; under *Mana value* / *Type* a group is derived, and the inactive categories are appended unchanged. |
| **variant** | `live` (what is sleeved up) or `theory` (what it is being built toward). |
| **tag** | Per-deck, colour-coded, **0 or 1 per card**. Suggestions are global across decks. |

---

## File Structure

### Rust — `src-tauri/src/`

| File | Responsibility |
|---|---|
| `schema.rs` *(modify)* | v8 migration: the four new tables, the `deck_cards` rebuild, new grain/kind constants. |
| `deck.rs` *(modify)* | Deck CRUD, card writes, allocator, `deck_get` — re-pointed from `zone` to `category_id`, threaded with `variant`. |
| `deck_meta.rs` *(create)* | Categories, tags and folders: rows, CRUD, `ensure_predefined_categories`. Split out because `deck.rs` is already 3 048 lines. |
| `deck_audit.rs` *(create)* | The audit row, `record()` (called inside every deck write's transaction) and `list()`. |
| `deck_theory.rs` *(create)* | `theory_diff` — cards in `theory` that `live` does not have. |
| `images.rs` *(modify)* | A `cover` route on `mtgimg://` serving `<data dir>/covers/<deckId>.webp`. |
| `reconcile.rs` *(modify)* | The three-table sweep keeps working over the rebuilt `deck_cards`. |
| `lib.rs` *(modify)* | Register the new commands. |

### TypeScript — `src/`

| File | Responsibility |
|---|---|
| `lib/ipc.ts` *(modify)* | The hand-written mirror: new DTOs and command wrappers. |
| `features/decks/validation/*` *(modify)* | Read `categoryKind` + `categoryActive` instead of `zone`. |
| `features/decks/grouping.ts` *(create)* | `buildGroups(cards, categories, groupBy)` — the one place a view learns what its groups are. |
| `features/decks/sorting.ts` *(create)* | `sortCards(cards, sortBy)` — alphabetical (default), mana cost, price, type. |
| `features/decks/autoCategory.ts` *(create)* | `autoCategoryFor(card)` — the type-line rule that names a card's category. |
| `features/decks/violations.ts` *(create)* | `violationsByCard(issues)` — `Map<cardId, ValidationIssue[]>` for per-card marking. |
| `features/decks/auditText.ts` *(create)* | Renders one `DeckAuditEntry` into its sentence + detail line. |
| `features/decks/useDeckMeta.ts` *(create)* | Categories, tags and their mutations for the open deck. |
| `features/decks/useDeckFolders.ts` *(create)* | The folder tree and its mutations. |
| `features/decks/useDeckAudit.ts` *(create)* | The audit query, grouped by day. |
| `features/decks/CardStack.tsx` *(create)* | One category's stack of cards, with the hover push-down. |
| `features/decks/views/StackView.tsx` *(create)* | Default view: columns of category stacks. |
| `features/decks/views/TableView.tsx` *(create)* | Grouped table. |
| `features/decks/views/TextView.tsx` *(create)* | Compact text columns. |
| `features/decks/views/GridView.tsx` *(create)* | Every card visible. |
| `features/decks/CategoriesPanel.tsx` *(create)* | Manage categories and tags. |
| `features/decks/AuditDrawer.tsx` *(create)* | The history drawer. |
| `features/decks/TheoryDiffDialog.tsx` *(create)* | Theory → Live difference list. |
| `features/decks/DeckSettingsDialog.tsx` *(create)* | Name, format, description, notes, cover, theory toggle, folder. |
| `features/decks/DeckEditor.tsx` *(rewrite)* | The shell: header, toolbar, whichever view is up, the stats aside. |
| `features/decks/DecksPage.tsx` *(rewrite)* | Folder tree + folder cards + deck tiles. |
| `features/decks/ZoneColumn.tsx` *(delete, Phase 2)* | Superseded by `CardStack` + the four views. |

---

# Phase 1 — the data model

Every task in this phase ends with a **green tree**: `npm run verify` passes. Task 3 carries a
mechanical re-point of the existing UI so that the contract change never leaves the build red.

---

### Task 1: Schema v8

**Files:**
- Modify: `src-tauri/src/schema.rs` (constants near `:151`–`:208`; new `if v < 7` step after `:692`)
- Test: `src-tauri/src/schema.rs` (the `mod tests` at the bottom)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub const SCHEMA_VERSION: i64 = 7;`
  - `pub const CATEGORY_KINDS: [&str; 5] = ["main", "side", "commander", "companion", "maybe"];`
  - `pub const PREDEFINED_CATEGORIES: [(&str, &str, bool); 4]` — `(kind, name, active)` for the four
    non-`main` kinds: `("commander", "Commander", true)`, `("side", "Sideboard", true)`,
    `("companion", "Companion", true)`, `("maybe", "Maybeboard", false)`.
  - `pub const DECK_CARD_GRAIN: &str = "deck_id, variant, category_id, card_id";`
  - `pub const DECK_CATEGORY_GRAIN: &str = "deck_id, name";`
  - `pub const DECK_TAG_GRAIN: &str = "deck_id, name";`
  - `pub const DECK_VARIANTS: [&str; 2] = ["live", "theory"];`
  - `pub const AUDIT_KINDS: [&str; 9] = ["add","remove","quantity","move","swap","tag","category","folder","deck"];`
  - `DECK_ZONES` is **deleted**.

- [ ] **Step 1: Write the failing tests**

Add to `schema.rs`'s test module. Four tests, each pinning one thing the step must be true about:

```rust
#[test]
fn the_v8_step_replaces_the_zone_with_a_category() {
    let mut conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    migrate(&mut conn).unwrap();

    // `zone` is gone from the table entirely, and `category_id` is NOT NULL.
    let cols: Vec<(String, i64)> = conn
        .prepare("SELECT name, \"notnull\" FROM pragma_table_info('deck_cards')")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    assert!(!cols.iter().any(|(n, _)| n == "zone"), "zone survived the rebuild");
    assert_eq!(cols.iter().find(|(n, _)| n == "category_id").unwrap().1, 1);
    assert!(cols.iter().any(|(n, _)| n == "variant"));
    assert!(cols.iter().any(|(n, _)| n == "tag_id"));
}

#[test]
fn the_v8_step_carries_a_v6_deck_across_into_categories() {
    // Build a v6 database by hand, put one card in each zone, migrate, and assert every
    // card kept its quantity and landed in a category of the matching kind. This is the
    // test that fails in the field and nowhere else if the backfill is wrong.
    // (See Step 3 for the fixture SQL.)
}

#[test]
fn the_v8_step_leaves_the_search_index_answering() {
    // The twin of the v2/v3/v5 tests: this step touches only user tables, so it owes no
    // `cards_fts` rebuild — and this is what proves the claim rather than assuming it.
}

#[test]
fn a_category_kind_is_one_of_the_five_and_predefined_names_round_trip() {
    // Walk CATEGORY_KINDS against the live CHECK, the way
    // `the_deck_card_grain_folds_and_the_zone_and_quantity_checks_hold` walked DECK_ZONES,
    // so the constant and the CHECK cannot drift apart unnoticed.
}
```

- [ ] **Step 2: Run them and watch them fail**

```bash
cd src-tauri && cargo test schema:: 2>&1 | tail -30
```
Expected: FAIL — `SCHEMA_VERSION` is still 6, `deck_cards` still has `zone`.

- [ ] **Step 3: Write the migration**

Add after the `if v < 6` block. The DDL, in full:

```rust
if v < 7 {
    let tx = conn.unchecked_transaction()?;
    // Plan 8. The deck's grouping stops being a fixed five-word enum and becomes rows the
    // user owns — so `deck_cards.zone` is replaced by `deck_cards.category_id`, and the
    // category carries the `kind` the rules used to read off the zone. Nothing about the
    // rules changed: `kind` takes exactly the five values `zone` took, and the validation
    // engine and the allocator read it in the same places. What is new is that a category
    // also has a NAME, an ORDER and an ACTIVE flag — and `is_active = 0` means "counts
    // toward nothing", which is precisely what `maybe` used to mean. So the scratchpad
    // stops being a special case in five files and becomes one seeded row.
    //
    // `zone` cannot be dropped in place: it is inside a CHECK and inside the unique index,
    // and SQLite refuses `DROP COLUMN` for either. The table is rebuilt, which is also how
    // `category_id` gets to be `NOT NULL` rather than nullable-with-a-promise.
    tx.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS deck_folders (
            id INTEGER PRIMARY KEY,
            -- User↔user, CASCADE: deleting a folder deletes the folders inside it. The
            -- DECKS inside it are NOT deleted — see `decks.folder_id` below, which is
            -- SET NULL. A folder is a filing decision; a deck is the user's work.
            parent_id INTEGER REFERENCES deck_folders(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            sort_order INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_deck_folders_parent ON deck_folders (parent_id);

         CREATE TABLE IF NOT EXISTS deck_categories (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            -- The rules role, and the same five words `deck_cards.zone` held. A category
            -- the user makes is always 'main'; the other four are predefined, one per deck.
            kind TEXT NOT NULL
                CHECK (kind IN ('main','side','commander','companion','maybe')),
            -- 'Only active groups are treated as being included in the deck.' Seeded 0 for
            -- the Maybeboard and 1 for everything else.
            is_active INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_categories_grain
            ON deck_categories ({category_grain});
         -- At most one predefined category per kind per deck. Partial, because 'main' is
         -- the kind every user category has and there may be forty of them.
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_categories_kind
            ON deck_categories (deck_id, kind) WHERE kind <> 'main';

         CREATE TABLE IF NOT EXISTS deck_tags (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            -- A token name from the app's fixed tag palette, not a hex string: the webview
            -- owns what a colour looks like, and a stored hex would outlive the theme.
            color TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );
         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_tags_grain
            ON deck_tags ({tag_grain});

         CREATE TABLE IF NOT EXISTS deck_audit (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            at INTEGER NOT NULL,
            variant TEXT NOT NULL DEFAULT 'live'
                CHECK (variant IN ('live','theory')),
            kind TEXT NOT NULL CHECK (kind IN
                ('add','remove','quantity','move','swap','tag','category','folder','deck')),
            -- Soft, like every card id in a user table, and nullable: a category rename
            -- is about no card at all.
            card_id TEXT,
            card_name TEXT,
            -- The facts the sentence is built from. Rust records WHAT happened; the
            -- webview writes the sentence, because a sentence is domain logic and this
            -- table has to survive the day the wording changes.
            payload TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(payload)),
            -- Signed copies, for the day header's '+7 / -6' roll-up.
            delta INTEGER NOT NULL DEFAULT 0
         );
         CREATE INDEX IF NOT EXISTS idx_deck_audit_deck ON deck_audit (deck_id, at DESC);

         ALTER TABLE decks ADD COLUMN folder_id INTEGER
            REFERENCES deck_folders(id) ON DELETE SET NULL;
         ALTER TABLE decks ADD COLUMN notes TEXT;
         ALTER TABLE decks ADD COLUMN theory_enabled INTEGER NOT NULL DEFAULT 0;",
        category_grain = DECK_CATEGORY_GRAIN,
        tag_grain = DECK_TAG_GRAIN,
    ))?;

    // One category per (deck, zone) that actually holds cards, named and flagged from
    // PREDEFINED_CATEGORIES — except 'main', whose legacy rows all land in one category
    // called 'Main deck'. Splitting those by card type is the app's `autoCategoryFor`
    // rule, which lives in TypeScript because it is domain logic; running a second copy of
    // it here would be two rules to keep in step. The categories panel offers
    // 'Auto-categorise from card types', which is that one rule, pressed once.
    tx.execute_batch(
        "INSERT INTO deck_categories (deck_id, name, kind, is_active, sort_order,
                                      created_at, updated_at)
         SELECT DISTINCT dc.deck_id,
                CASE dc.zone WHEN 'main' THEN 'Main deck'
                             WHEN 'side' THEN 'Sideboard'
                             WHEN 'commander' THEN 'Commander'
                             WHEN 'companion' THEN 'Companion'
                             ELSE 'Maybeboard' END,
                dc.zone,
                CASE dc.zone WHEN 'maybe' THEN 0 ELSE 1 END,
                CASE dc.zone WHEN 'commander' THEN 0 WHEN 'main' THEN 1
                             WHEN 'side' THEN 2 WHEN 'companion' THEN 3 ELSE 4 END,
                unixepoch(), unixepoch()
           FROM deck_cards dc;",
    )?;

    // The rebuild. `category_id` is NOT NULL from the first row, which is only possible
    // because the categories above already exist.
    tx.execute_batch(&format!(
        "CREATE TABLE deck_cards_v8 (
            id INTEGER PRIMARY KEY,
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            -- CASCADE: deleting a category deletes the cards filed under it, which is
            -- what the confirm dialog says it will do. Moving them out first is the
            -- caller's job and `deck_category_delete` does exactly that when asked.
            category_id INTEGER NOT NULL
                REFERENCES deck_categories(id) ON DELETE CASCADE,
            variant TEXT NOT NULL DEFAULT 'live'
                CHECK (variant IN ('live','theory')),
            card_id TEXT NOT NULL,
            set_code TEXT NOT NULL,
            collector_number TEXT NOT NULL,
            lang TEXT NOT NULL DEFAULT 'en',
            name TEXT NOT NULL,
            -- SET NULL, not CASCADE: deleting a tag must never delete a card.
            tag_id INTEGER REFERENCES deck_tags(id) ON DELETE SET NULL,
            quantity INTEGER NOT NULL CHECK (quantity > 0),
            needs_review TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
         );

         INSERT INTO deck_cards_v8
            (id, deck_id, category_id, variant, card_id, set_code, collector_number,
             lang, name, tag_id, quantity, needs_review, created_at, updated_at)
         SELECT dc.id, dc.deck_id, cat.id, 'live', dc.card_id, dc.set_code,
                dc.collector_number, dc.lang, dc.name, NULL, dc.quantity,
                dc.needs_review, dc.created_at, dc.updated_at
           FROM deck_cards dc
           JOIN deck_categories cat
             ON cat.deck_id = dc.deck_id AND cat.kind = dc.zone;

         DROP TABLE deck_cards;
         ALTER TABLE deck_cards_v8 RENAME TO deck_cards;

         CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_cards_grain
            ON deck_cards ({deck_grain});
         CREATE INDEX IF NOT EXISTS idx_deck_cards_card ON deck_cards (card_id);
         CREATE INDEX IF NOT EXISTS idx_deck_cards_category ON deck_cards (category_id);",
        deck_grain = DECK_CARD_GRAIN,
    ))?;

    // Literal `7`, for the reason every step before it writes its own.
    tx.execute_batch("PRAGMA user_version = 7;")?;
    tx.commit()?;
}
```

> **Trap, and it is the one that will bite:** `DROP TABLE deck_cards` fires `deck_cards`' own
> outbound FKs, not its inbound ones — there are none inbound — but it runs under
> `PRAGMA foreign_keys=ON` inside a transaction. `PRAGMA foreign_keys` is a **no-op inside a
> transaction**, so it must be whatever it already was; do not try to toggle it here. The rename
> keeps the row ids, which is what lets `deck_allocations` and anything holding a `deck_cards.id`
> stay correct.

- [ ] **Step 4: Run the tests**

```bash
cd src-tauri && cargo test schema:: 2>&1 | tail -30
```
Expected: PASS, all four.

- [ ] **Step 5: Fix every `DECK_ZONES` reference the compiler now flags**

`cargo check` will name them. They are all in `deck.rs` and its tests; re-point them at
`CATEGORY_KINDS` where they mean "the five rules roles" and leave the rest to Task 3.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/schema.rs
git commit -m "feat(schema): v8 replaces the deck zone with user-owned categories"
```

---

### Task 2: Categories, tags and folders in Rust

**Files:**
- Create: `src-tauri/src/deck_meta.rs`
- Modify: `src-tauri/src/lib.rs` (`mod` list; `invoke_handler` at `:182`–`:211`)
- Test: `src-tauri/src/deck_meta.rs` (`mod tests`)

**Interfaces:**
- Consumes: `schema::{PREDEFINED_CATEGORIES, DECK_CATEGORY_GRAIN, DECK_TAG_GRAIN}`;
  `deck::{touch_deck, GONE}`; `db::lock_for`; `collection::BUSY`.
- Produces (every struct `#[serde(rename_all = "camelCase")]`):

```rust
pub struct DeckCategoryRow {
    pub id: i64, pub deck_id: i64, pub name: String, pub kind: String,
    pub is_active: bool, pub sort_order: i64,
    /// Cards filed here in the variant that was asked for.
    pub card_count: i64,
    /// Nonfoil `usd` × copies, summed. `None` when nothing here has a price.
    pub total_price_usd: Option<f64>,
}
pub struct DeckTagRow {
    pub id: i64, pub deck_id: i64, pub name: String, pub color: String, pub card_count: i64,
}

pub fn ensure_predefined_categories(conn: &Connection, deck_id: i64) -> Result<(), String>;
pub fn list_categories(conn: &Connection, deck_id: i64, variant: &str)
    -> Result<Vec<DeckCategoryRow>, String>;
/// Find-or-create by name. The add path's "find its card category or create it".
/// Always creates with `kind = 'main'`.
pub fn category_for_name(conn: &Connection, deck_id: i64, name: &str) -> Result<i64, String>;
```

Commands, all `#[tauri::command] pub async fn`:
`deck_category_list(deckId, variant)` · `deck_category_create(deckId, name)` ·
`deck_category_rename(id, name)` · `deck_category_set_active(id, isActive)` ·
`deck_category_reorder(deckId, ids)` · `deck_category_delete(id, moveToCategoryId: Option<i64>)` ·
`deck_tag_list(deckId)` · `deck_tag_create(deckId, name, color)` ·
`deck_tag_update(id, name, color)` · `deck_tag_delete(id)` · `deck_tag_suggestions()` ·
`deck_card_set_tag(deckId, cardId, categoryId, variant, tagId: Option<i64>)` ·
`deck_folder_list()` · `deck_folder_create(parentId, name)` · `deck_folder_rename(id, name)` ·
`deck_folder_move(id, parentId)` · `deck_folder_delete(id)`.

**Rules this task must get right:**

1. **A predefined category cannot be renamed or deleted.** `deck_category_rename` and
   `deck_category_delete` refuse `kind <> 'main'` in words:
   `"Commander is required by this deck's rules — it can be emptied but not removed."`
   `is_active` **is** settable on all five: deactivating Commander is a legal (if unwise) thing to
   do, and validation will say what it costs. No format branch anywhere.
2. **`deck_category_delete` with `moveToCategoryId: Some(id)` moves the cards first**, in the same
   transaction, folding on the grain; with `None` it lets the CASCADE take them. Two behaviours, one
   command, because the dialog offers both and a caller that had to do it in two round trips could
   lose the cards between them.
3. **`deck_folder_move` refuses a cycle** — a folder cannot be moved inside its own descendant.
   Walk `parent_id` upward from the proposed parent; if you meet `id`, refuse:
   `"A folder cannot be moved inside itself."`
4. **`deck_tag_suggestions` is global** — `SELECT DISTINCT name, color FROM deck_tags ORDER BY
   count(*) DESC, name` across every deck. Tags themselves stay per-deck.
5. **A card carries 0 or 1 tags**, which is the `tag_id` column and needs no enforcement beyond it.
6. Every write goes through `touch_deck` (so the gallery's `updatedAt` moves) and records an audit
   row (Task 4 adds the call; leave a `// TODO(Task 4)` nowhere — Task 4 edits this file).

- [ ] **Step 1: Write the failing tests** — one per numbered rule above, plus
      `ensure_predefined_categories_is_idempotent` and
      `category_for_name_finds_before_it_creates`.
- [ ] **Step 2: Run them, watch them fail** (`cargo test deck_meta::`).
- [ ] **Step 3: Implement `deck_meta.rs`.**
- [ ] **Step 4: Register the commands in `lib.rs` and run `cargo test`.**
- [ ] **Step 5: Commit** — `feat(decks): categories, tags and folders`

---

### Task 3: Re-point `deck.rs` from zones to categories, and keep the tree green

**Files:**
- Modify: `src-tauri/src/deck.rs` (`DECK_SELECT :227`, `DECK_CARD_SELECT :861`, `add_card :401`,
  `set_card_quantity :471`, `move_card :535`, `swap_printing :624`, `ZONE_PRIORITY :742`,
  `read_deck_cards :889`, `allocate_deck :1124`, `missing_to_wishlist :1237`, every command `:1337`+)
- Modify: `src-tauri/src/reconcile.rs` (the `deck_cards` arm of the sweep)
- Modify: `src-tauri/src/images.rs` (`prewarm_keys`' `deck_cards` arm)
- Modify: `src/lib/ipc.ts`, `src/features/decks/**` — the **mechanical** re-point only
- Test: `src-tauri/src/deck.rs` tests; `src/features/decks/*.test.ts(x)`

**Interfaces:**
- Consumes: Task 1's constants, Task 2's `ensure_predefined_categories` / `category_for_name`.
- Produces — the shape every later task builds on:

```rust
pub struct DeckCardRow {
    pub id: i64,
    pub card_id: String,
    // was: pub zone: String
    pub category_id: i64,
    pub category_name: String,
    /// 'main' | 'side' | 'commander' | 'companion' | 'maybe' — what the rules read.
    pub category_kind: String,
    /// An inactive category counts toward nothing: not size, not copies, not legality,
    /// and the allocator claims no copy for it.
    pub category_active: bool,
    pub variant: String,
    pub tag_id: Option<i64>,
    pub tag_name: Option<String>,
    pub tag_color: Option<String>,
    // …every existing field unchanged…
}

pub struct DeckDetail {
    pub deck: DeckRow,
    pub cards: Vec<DeckCardRow>,
    pub categories: Vec<crate::deck_meta::DeckCategoryRow>,
    pub tags: Vec<crate::deck_meta::DeckTagRow>,
}
```

Command signature changes — **every one of these takes `categoryId: i64` where it took
`zone: DeckZone`, and gains `variant: String`**:

| Was | Now |
|---|---|
| `deck_add_card(deckId, cardId, zone, quantity)` | `deck_add_card(deckId, cardId, categoryId: Option<i64>, categoryName: Option<String>, variant, quantity)` |
| `deck_set_card_quantity(deckId, cardId, zone, quantity)` | `deck_set_card_quantity(deckId, cardId, categoryId, variant, quantity)` |
| `deck_move_card(deckId, cardId, from, to)` | `deck_move_card(deckId, cardId, fromCategoryId, toCategoryId, variant)` |
| `deck_swap_printing(deckId, fromCardId, toCardId, zone)` | `deck_swap_printing(deckId, fromCardId, toCardId, categoryId, variant)` |
| `deck_get(id)` | `deck_get(id, variant)` |

`deck_add_card` takes **either** an explicit `categoryId` **or** a `categoryName` to find-or-create —
that pair is the spec's "when a card is added but not to a specific category, it should find its card
category or create it if it does not exist", with the *name* computed in TypeScript by
`autoCategoryFor` (Task 9). Both `None` is refused in words:
`"A card needs a category to go in."`

**Rules this task must get right:**

1. **`ZONE_PRIORITY` becomes `KIND_PRIORITY`** — `["commander", "main", "side", "companion", "maybe"]`
   — and the allocator's "skip `maybe`" becomes **"skip any card whose category is inactive"**. That
   is the whole of the maybe special case disappearing, and it is the change most likely to be got
   half-right: search `deck.rs` for `MAYBE` and make sure every use is gone.
2. **`allocate_deck` allocates the `live` variant only.** A theory list is a plan; it reserves
   nothing. Pin it: `the_allocator_claims_nothing_for_the_theory_variant`.
3. **`DeckRow.card_count`** counts `variant = 'live'` rows in **active** categories of kind
   `main` + `commander` — `SIZE_ZONES` unchanged in substance.
4. **`deck_get(id, variant)`** returns that variant's cards, but **all** categories and tags: an
   empty category still draws, and an inactive one always draws.
5. `deck_duplicate` copies categories and tags **and both variants**, and no allocations.
6. Order: cards come back in category `sort_order`, then the name the row carries, then row id.
   `ownedQuantity` is attributed along that order, so it must not depend on how a view displayed it.

**The mechanical UI re-point (Step 5) is deliberately dumb.** `ZoneColumn` keeps its shape; it is
handed a category's cards and its name instead of a zone's. `DeckEditor`'s `COLUMNS` becomes "the
categories, in `sort_order`". No new affordance, no new layout — Phase 2 replaces all of it, and the
only job here is that `npm run verify` is green at the commit boundary.

- [ ] **Step 1: Write the failing tests** — the six rules above, in `deck.rs`'s test module.
- [ ] **Step 2: Run them, watch them fail.**
- [ ] **Step 3: Re-point `deck.rs`, `reconcile.rs`, `images.rs`.**
- [ ] **Step 4: `cargo test` green.**
- [ ] **Step 5: Mechanically re-point `ipc.ts` and `src/features/decks/**` so the build passes.**
- [ ] **Step 6: `npm run verify` green. Commit** —
      `feat(decks)!: address deck cards by category instead of zone`

---

### Task 4: The audit log

**Files:**
- Create: `src-tauri/src/deck_audit.rs`
- Modify: `src-tauri/src/deck.rs`, `src-tauri/src/deck_meta.rs` (one `record(…)` call per write)
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

```rust
pub struct DeckAuditEntry {
    pub id: i64, pub deck_id: i64, pub at: i64, pub variant: String,
    pub kind: String, pub card_id: Option<String>, pub card_name: Option<String>,
    /// JSON. Read it in TypeScript; `auditText.ts` renders the sentence.
    pub payload: String,
    pub delta: i64,
}

/// Called INSIDE the caller's transaction, always — an audit row that committed while the
/// change it describes rolled back is a history that lies.
pub fn record(tx: &Connection, deck_id: i64, variant: &str, kind: &str,
              card: Option<(&str, &str)>, payload: &serde_json::Value, delta: i64)
    -> Result<(), String>;

pub fn list(conn: &Connection, deck_id: i64, limit: i64) -> Result<Vec<DeckAuditEntry>, String>;
```

Command: `deck_audit_list(deckId, limit)`.

**Payload shapes, by kind** — `auditText.ts` (Task 9) is written against exactly these:

| kind | payload |
|---|---|
| `add` | `{ "category": "Ramp", "quantity": 1 }` |
| `remove` | `{ "category": "Ramp", "quantity": 1, "reason": null }` |
| `quantity` | `{ "category": "Ramp", "from": 1, "to": 2 }` |
| `move` | `{ "from": "Creature", "to": "Maybeboard" }` |
| `swap` | `{ "category": "Ramp", "fromSet": "CMM", "toSet": "3ED", "folded": false }` |
| `tag` | `{ "tag": "Cut candidate", "previous": null }` |
| `category` | `{ "action": "create\|rename\|delete\|activate\|deactivate\|reorder", "name": "Draw", "previousName": "Value", "cards": 7 }` |
| `folder` | `{ "action": "move", "folder": "Commander › Legends" }` |
| `deck` | `{ "field": "name\|format\|cover\|notes\|built\|theory", "from": "…", "to": "…" }` |

**Rules:**
1. **Every deck write records exactly one row.** The audit is the spec's "log ALL changes";
   a write that silently records nothing is the bug this table exists to prevent. Pin it with
   `every_deck_write_leaves_exactly_one_audit_row`, which drives each command once and counts.
2. `record` takes `&Connection` that is already inside a transaction. Never open its own.
3. `delta` is signed copies for the day roll-up: `+n` on add, `-n` on remove, the difference on
   `quantity`, `0` on everything else.

- [ ] **Step 1: Write `every_deck_write_leaves_exactly_one_audit_row` and one payload test per kind.**
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement `deck_audit.rs` and thread `record` through every write.**
- [ ] **Step 4: `cargo test` green.**
- [ ] **Step 5: Commit** — `feat(decks): record every deck change in an audit log`

---

### Task 5: Live/Theory and the difference list

**Files:**
- Create: `src-tauri/src/deck_theory.rs`
- Modify: `src-tauri/src/deck.rs` (`DeckPatch` gains `theory_enabled`, `notes`, `folder_id`)
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

```rust
pub struct TheoryDiffRow {
    pub card_id: String, pub name: String, pub category_name: String,
    /// How many more copies theory wants than live has.
    pub quantity: i64,
    pub unit_price_usd: Option<f64>,
    pub set_code: String, pub collector_number: String,
    /// Copies of this oracle card the collection holds and no built deck has claimed.
    pub owned_spare: i64,
}

/// Cards the THEORY list holds that LIVE does not — one direction only, which is what the
/// spec asks for: this is a shopping list, not a reconciliation.
/// Compared by oracle card, not by printing: needing a second Sol Ring is not answered by
/// owning a different printing of one you already have in the live list.
pub fn theory_diff(conn: &Connection, deck_id: i64) -> Result<Vec<TheoryDiffRow>, String>;
```

Commands: `deck_theory_diff(deckId)` · `deck_theory_copy_from_live(deckId)` (seeds an empty theory
list from live, so enabling the toggle does not start from nothing) ·
`deck_theory_missing_to_wishlist(deckId)`.

**Rules:**
1. Enabling `theoryEnabled` on a deck whose `theory` variant is empty **copies live into it**, in
   the same transaction. An empty theory list beside a full live one reads as data loss.
2. `theory_diff` sums by `oracle_id`, falling back to `card_id` when the row is an orphan.
3. `owned_spare` is the collection's copies minus what **built** decks have allocated —
   `deck_allocations` joined through `decks.is_built`.
4. Disabling `theoryEnabled` **keeps the rows**. It hides the switch; it does not delete a list.

- [ ] **Step 1: Tests** — `enabling_theory_seeds_it_from_live`,
      `the_diff_only_reports_what_theory_has_more_of`, `the_diff_compares_oracle_cards_not_printings`,
      `disabling_theory_keeps_the_rows`.
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(decks): live and theory deck variants with a difference list`

---

### Task 6: Custom deck covers over `mtgimg://`

**Files:**
- Modify: `src-tauri/src/images.rs` (`serve` at `:816`), `src-tauri/src/deck.rs`, `src-tauri/src/paths.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**

```rust
/// `<data dir>/covers`. Created on demand; safe to delete, like `images/`.
pub fn covers_dir(app: &tauri::AppHandle) -> Result<PathBuf, String>;
```

Command: `deck_set_cover_image(deckId, sourcePath: String)` — reads the file, decodes it, re-encodes
to WEBP at 626×457 (the `art` crop's aspect, so a cover and a card art crop are interchangeable in
every tile), writes `<covers>/<deckId>.webp`, and sets `cover_kind = 'custom'` +
`cover_image_path`. `deck_update(coverCardId)` sets `cover_kind = 'card_art'` and leaves the file.

**Rules:**
1. **`mtgimg://<origin>/cover/<deckId>` is a fifth route beside the four `IMAGE_VARIANTS`.**
   It is served `no-store` — a cover is the one image whose bytes are meant to change under a
   stable URL.
2. A missing file is a **404**, not a placeholder: a deck with no custom cover falls back to its
   card art in the webview, and a placeholder here would hide that.
3. The CSP is **unchanged**. `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` must still
   pass untouched — if it needs an edit, the route is wrong.
4. Deleting a deck deletes its cover file. Best-effort: a failure is logged, never fatal.

- [ ] **Step 1: Tests** — `a_cover_route_serves_the_file_and_404s_when_there_is_none`,
      `the_shipped_csp_is_untouched`, `deleting_a_deck_takes_its_cover_file`.
- [ ] **Step 2–4: fail → implement → pass.**
- [ ] **Step 5: Commit** — `feat(decks): custom deck cover images`

---

### Task 7: Mirror the whole contract in `ipc.ts`

**Files:**
- Modify: `src/lib/ipc.ts`
- Test: `src/lib/ipc.test.ts`

Write to this file's existing standard: every field documented, every trap named. New types:
`DeckVariant` (`"live" | "theory"`), `CategoryKind`, `DeckCategory`, `DeckTag`, `TagColor`,
`DeckFolder`, `DeckAuditEntry`, `DeckAuditKind`, `TheoryDiffRow`; `DeckCard` loses `zone` and gains
`categoryId`/`categoryName`/`categoryKind`/`categoryActive`/`variant`/`tagId`/`tagName`/`tagColor`;
`DeckDetail` gains `categories` and `tags`; `DeckPatch` gains `notes`, `folderId`, `theoryEnabled`.

**The one paragraph this file must gain**, because it is the invariant everything downstream leans
on:

> **`categoryActive` is the whole of what `maybe` used to mean.** A card in an inactive category
> counts toward no deck size, no copy limit and no legality check, and the allocator claims no copy
> for it — so its `ownedQuantity` is always `0`. The Maybeboard is simply the one predefined
> category seeded inactive; a user category switched off behaves identically, and nothing in the
> engine, the allocator or the stats needs to know which is which.

- [ ] **Step 1:** update `ipc.test.ts`'s shape assertions first, watch them fail.
- [ ] **Step 2:** write the types and wrappers.
- [ ] **Step 3:** `npm run test:run src/lib/ipc.test.ts` green.
- [ ] **Step 4: Commit** — `feat(ipc): mirror the category, tag, folder, audit and theory contract`

---

### Task 8: Re-point the validation engine onto categories

**Files:**
- Modify: `src/features/decks/validation/engine.ts` (`SIZE_ZONES :44`, `COPY_ZONES :~68`,
  `validateDeck :~80`), `commanders.ts`, `companions.ts`, `bracket.ts`, `fixtures.ts`
- Test: the four existing `*.test.ts` files

**Interfaces:**
- `SIZE_ZONES` → `export const SIZE_KINDS: readonly CategoryKind[] = ["main", "commander"];`
- `COPY_ZONES` → `COPY_KINDS = ["main", "side", "commander", "companion"]`
- `validateDeck(cards, spec)` — signature unchanged, but its first line changes from
  `cards.filter((card) => card.zone !== "maybe")` to `cards.filter((card) => card.categoryActive)`.

**Rules:**
1. **One line carries the whole semantic change** and it must be that line: filtering on
   `categoryActive` rather than on a kind is what makes a user-deactivated category behave like the
   Maybeboard. A filter written as `card.categoryKind !== "maybe"` compiles, passes every existing
   test, and silently counts a deactivated category — write the test that catches it:
   `a_deactivated_category_counts_toward_nothing`.
2. Everything else is a rename: `card.zone` → `card.categoryKind`.
3. `bracket.ts` reads `gameChanger` and is untouched apart from the rename.

- [ ] **Step 1:** add `a_deactivated_category_counts_toward_nothing` to `engine.test.ts`; watch fail.
- [ ] **Step 2:** rename through, fix `fixtures.ts`.
- [ ] **Step 3:** `npm run test:run src/features/decks/validation` green.
- [ ] **Step 4: Commit** — `refactor(decks): validate by category kind and active flag`

---

### Task 9: The TypeScript domain modules

**Files:**
- Create: `src/features/decks/autoCategory.ts` + `.test.ts`
- Create: `src/features/decks/grouping.ts` + `.test.ts`
- Create: `src/features/decks/sorting.ts` + `.test.ts`
- Create: `src/features/decks/violations.ts` + `.test.ts`
- Create: `src/features/decks/auditText.ts` + `.test.ts`

**Interfaces:**

```ts
// autoCategory.ts — the rule the add path uses when the reader did not pick a category.
// Read off the TYPE LINE and nothing else, in this order, first match wins. Order matters:
// an Artifact Creature is a Creature, and a Legendary Creature that is a commander was
// placed explicitly and never reaches here.
export const AUTO_CATEGORIES = [
  "Land", "Creature", "Artifact", "Enchantment", "Planeswalker",
  "Battle", "Instant", "Sorcery",
] as const;
export function autoCategoryFor(card: Pick<DeckCard, "typeLine">): string;
// A card with no type line — an orphan — answers "Uncategorised", never "".

// grouping.ts — the one place a view learns what its groups are.
export type GroupBy = "category" | "manaValue" | "type";
export interface CardGroup {
  key: string;            // stable react key
  name: string;
  kind: CategoryKind | null;   // null for a derived group
  categoryId: number | null;   // null for a derived group
  isActive: boolean;
  isPredefined: boolean;
  cards: DeckCard[];
  count: number;               // copies, not rows
  totalPriceUsd: number | null;
}
export function buildGroups(
  cards: readonly DeckCard[],
  categories: readonly DeckCategory[],
  groupBy: GroupBy,
  sortBy: SortBy,
): CardGroup[];

// sorting.ts
export type SortBy = "alphabetical" | "manaCost" | "price" | "type";
export function sortCards(cards: readonly DeckCard[], sortBy: SortBy): DeckCard[];

// violations.ts
export function violationsByCard(issues: readonly ValidationIssue[])
  : Map<string, ValidationIssue[]>;

// auditText.ts
export function auditSentence(entry: DeckAuditEntry): { text: string; detail: string | null };
export function auditDays(entries: readonly DeckAuditEntry[])
  : { date: string; label: string; delta: number; entries: DeckAuditEntry[] }[];
```

**Rules — these are the ones the spec is explicit about and a test must pin each:**
1. **Inactive groups are always displayed, whatever the grouping.** Under `manaValue` or `type`,
   `buildGroups` derives groups from the **active** cards only and then appends every **inactive
   category** as itself, unchanged and in `sort_order`. Test:
   `inactive_categories_survive_every_grouping`.
2. **Empty predefined categories still draw** (an empty Sideboard is a place to drop a card);
   empty *user* categories draw too, so a category made and not yet filled does not vanish.
   Derived groups with no cards do not exist at all.
3. `count` is **copies**, not rows — `sum(quantity)`.
4. `totalPriceUsd` is `sum(unitPriceUsd × quantity)`, `null` when every card in the group is
   unpriced, and skips unpriced cards otherwise (a partial total is more useful than none, and the
   surface says `PRICES_AS_OF`).
5. **`sortCards` is stable and total**: nulls sort last within their key, ties break on name, and it
   never throws on an orphan. `manaCost` sorts by `cmc` then by name; `type` sorts by
   `AUTO_CATEGORIES` order then by name.
6. `auditDays` groups by **local** calendar day and labels today/yesterday in words; `delta` is the
   day's summed `delta`.

- [ ] **Step 1: Write all five test files first.** Every numbered rule gets a named test.
- [ ] **Step 2: Run, watch fail.**
- [ ] **Step 3: Implement the five modules.**
- [ ] **Step 4: `npm run verify` green.**
- [ ] **Step 5: Commit** — `feat(decks): grouping, sorting, auto-category and audit-text rules`

---

# Phase 2 — the deck builder

The design canvas is the brief. Every task here reads it first:
`claude.ai/design/p/f6dac504-6f67-49fc-9807-2157ab0c9189` → `Deck Builder.dc.html`, plus
`docs/superpowers/specs/2026-08-04-visual-design-direction.md`.

---

### Task 10: The hooks

**Files:**
- Create: `src/features/decks/useDeckMeta.ts`, `useDeckFolders.ts`, `useDeckAudit.ts` + tests
- Modify: `src/features/decks/useDeck.ts`

**Interfaces:**

```ts
export function useDeck(id: number | null, variant: DeckVariant): {
  query; deck; cards; categories; tags;
  update; addCard; setQuantity; moveCard; swapPrinting; setTag; missingToWishlist;
};
export function useDeckMeta(deckId: number | null): {
  categories; tags; suggestions;
  createCategory; renameCategory; setCategoryActive; reorderCategories; deleteCategory;
  autoCategorise;            // runs autoCategoryFor over every uncategorised main card
  createTag; updateTag; deleteTag;
};
export function useDeckFolders(): { folders; create; rename; move; remove };
export function useDeckAudit(deckId: number | null): { days; query };
```

**Rules:**
1. **The refusal rule stays on the single mutation definition**, never on a call site — two
   definitions would be two places to keep one rule. Every new mutation invalidates `["decks"]` on
   success *and* on error, for the reason `useDeck.ts` already documents.
2. `setQuantity` keeps its optimistic patch and its cancel-then-roll-back; the slot it patches is
   now `(cardId, categoryId, variant)`.
3. Switching variant is a **query key change**, not a refetch: `["decks", "detail", id, variant]`.

- [ ] **Steps 1–5:** test → fail → implement → pass → commit
      `feat(decks): hooks for categories, tags, folders and history`

---

### Task 11: `CardStack` — the hover push-down

**Files:**
- Create: `src/features/decks/CardStack.tsx` + `.test.tsx` + `.stories.tsx`

This is the signature interaction of the whole redesign and the one thing a test cannot see, so it
gets its own task and a live CDP pass.

**The geometry, from the canvas:** each card in a stack shows only its 30px title bar; the last one
is drawn in full because nothing covers it. The list is given a **fixed height** —
`34 * cards.length + 286` px — which is the collapsed stack plus one card's worth of slack, so a card
lifted under the pointer **overflows the list instead of resizing it**. That is the whole trick: the
group, and every group under it in the column, never moves while the reader runs down a stack.

```tsx
// Collapsed: every card but the last is pulled up over its neighbour.
<li style={{ marginBottom: hovered ? "8px" : "-278px" }} />
```

**Rules:**
1. **The stack never reflows.** Pin it: `hovering_a_card_does_not_change_the_group_height`.
2. Hover raises the card's own `z-index` (from `LAYER`, written out — no interpolated class).
3. `motion-reduce:transition-none` on the lift. **Probe `transitionProperty`, never
   `transitionDuration`** when verifying over CDP — Tailwind's `transition-none` leaves the duration
   alone and a duration check reports a false failure.
4. Keyboard reaches every card: the stack is a list, each card a link/button, and **focus does the
   same thing hover does** — a stack only a mouse can read is a stack half the readers cannot.
5. Art through `CardImage`, keyed on its own URL.
6. Per-card: quantity badge, name, mana cost (`ManaText`), tag dot (colour-coded, name on hover),
   `RarityGem` + set line + **its own price**, a `GC` badge for a game changer and a distinct
   `RULE BREAK` mark for a violation — the two must not be confusable, which is the spec's own
   requirement.

- [ ] **Steps 1–5:** test → fail → implement → pass → commit `feat(decks): the card stack`

---

### Task 12: The four views

**Files:**
- Create: `src/features/decks/views/{StackView,TableView,TextView,GridView}.tsx` + tests + stories

Each takes `CardGroup[]` and renders it. `StackView` is the default and lays groups into columns;
`TableView` reuses `components/table/VirtualTable`; `TextView` is compact columns; `GridView` shows
every card. Group headers everywhere carry **name, count and summed cost**, plus `RULE` and
`INACTIVE` markers.

- [ ] **Steps 1–5:** test → fail → implement → pass → commit `feat(decks): stack, table, text and grid views`

---

### Task 13: The editor shell

**Files:**
- Rewrite: `src/features/decks/DeckEditor.tsx`; delete `ZoneColumn.tsx` and its test/story
- Modify: `src/features/decks/dnd.ts` (drops now name a category, not a zone)

Header: back, name field, **Live/Theory switch** + "n cards differ", format select, Built chip, the
issues chip, and buttons for Categories & tags / History / Deck settings. Toolbar: quick add,
view switch, **group by** (Categories / Mana value / Type), **sort** (Alphabetical / Mana cost /
Price / Type), deck filter, tag filter chips, Stats toggle.

**Rules:** the Escape handshake and the "never two `"inner"` peers" rule from
`DeckEditor.tsx:127`'s `Layer` union carry over verbatim — the union just gets more members.

- [ ] **Steps 1–5:** test → fail → implement → pass → commit `feat(decks): the rebuilt deck editor`

---

### Task 14: Categories & tags panel

**Files:** create `CategoriesPanel.tsx` + test + story.

Reorderable category list with `RULE` locks, active toggles, per-category count and price, an add
field, **"Auto-categorise from card types"**; a tag list with colour swatch, rename, delete, and
global suggestions as dashed chips.

- [ ] **Steps 1–5:** commit `feat(decks): manage categories and tags`

### Task 15: History drawer

**Files:** create `AuditDrawer.tsx` + test + story. Day sections with sticky headers, a signed
delta, kind filter chips, one line per entry through `auditSentence`.

- [ ] **Steps 1–5:** commit `feat(decks): the deck history drawer`

### Task 16: Theory difference dialog

**Files:** create `TheoryDiffDialog.tsx` + test + story. Figures (cards to find, cost to build,
already owned), the rows, per-row and bulk "send to wishlist", and the line that says the other
direction is deliberately not listed.

- [ ] **Steps 1–5:** commit `feat(decks): the theory-to-live difference list`

### Task 17: Deck settings dialog

**Files:** create `DeckSettingsDialog.tsx` + test + story. Cover preview, art picker from the cards
in the deck (commander first for a commander deck), upload, name, format, description, notes, the
theory toggle and the folder move control.

- [ ] **Steps 1–5:** commit `feat(decks): deck settings, notes and cover picking`

### Task 18: Decks page with folders

**Files:** rewrite `DecksPage.tsx`; create `FolderTree.tsx`. Nested folder sidebar with create-at-
any-level, folder cards and deck tiles with LIVE / LIVE + THEORY badges, and decks draggable into
folders.

- [ ] **Steps 1–5:** commit `feat(decks): organise decks into folders`

---

### Task 19: Storybook

**Files:** modify `.storybook/fake/db.ts`, `world.ts`, `fixtures.ts`; add the stories any earlier
task deferred.

The fake stores **table rows and derives DTOs** — so it gains `deck_categories`, `deck_tags`,
`deck_audit` and the `variant` column, and derives `DeckCard.categoryName`/`categoryActive` rather
than storing them. A world belongs to a story, not to the module. Seeds gain a deck with two
variants, a deactivated user category, a tagged card and a violation.

- [ ] **Steps 1–5:** commit `test(storybook): story the rebuilt deck builder`

### Task 20: Live pass, docs and verify

- [ ] Drive the real window over CDP (`scripts/cdp.mjs`): the stack hover (`hover --rest --probe`,
      probing `transitionProperty`), a drag between categories (remembering
      `"dragDropEnabled": false` is load-bearing and the config is compiled in), the four views, the
      audit drawer, the theory switch, a cover upload.
- [ ] Record what was **measured** — not assumed — in `CLAUDE.md`: the category model replacing
      zones, the new FKs and their `ON DELETE` reasoning, the audit contract, the variant grain, the
      cover route, and the auto-categorise migration hand-off.
- [ ] `npm run verify` green. Commit `docs: record the deck builder rebuild`.

---

## Self-review notes

- **Spec coverage.** Visual-first stacks → 11/12. Custom categories, named + active/inactive → 1, 2,
  14. Only active groups count → 1 (DDL), 8 (engine), 9 (grouping). Maybeboard inactive by default →
  1's `PREDEFINED_CATEGORIES`. Count + sum cost per group → 9's `CardGroup`, 12's headers. Group by
  category/mana value/type → 9, 13. Inactive always displayed → 9 rule 1. Predefined rule groups →
  1, 2. Hover push-down → 11. Per-card cost → 11. Tags (per deck, 0–1, colour, global suggestions,
  filter + sort) → 1, 2, 13, 14. Violation and game-changer marking → 9's `violations.ts`, 11.
  Audit log, grouped by date → 4, 9, 15. Four views → 12. Stack sorting → 9, 13. Folders → 1, 2, 18.
  Live/Theory + enable/disable + diff → 1, 5, 16. Deck picture from card art or upload → 6, 17.
  Description + notes → 1, 7, 17.
- **Known hand-off, stated rather than hidden:** the v8 migration files every legacy `main` card
  into one **"Main deck"** category rather than splitting it by type. Splitting is
  `autoCategoryFor`, which lives in TypeScript because it is domain logic, and a second copy in the
  migration would be two rules to keep in step. The categories panel's **"Auto-categorise from card
  types"** is that one rule, pressed once. New decks are unaffected — they categorise on the way in.
