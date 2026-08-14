# Right-click Context Menus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace WebView2's native right-click menu with a custom one whose contents depend on what was clicked — a card, a deck, a folder or a deck category.

**Architecture:** One `ContextMenuProvider` mounted at the app root renders the single menu instance; surfaces call `openMenu(items, at)` through context and never render a menu themselves. A menu is **data** — a `MenuItem[]` — with a `lazy` kind whose component mounts only when its submenu is expanded, so nothing reaches the backend before the reader asks. `useDismissOnEscape` gains a capture-layer stack so a menu over a dialog over the card pane is ordered rather than hoped about.

**Tech Stack:** React 19, TypeScript 6, Tailwind v4, `motion@13.1.0`, Vitest + Testing Library, Storybook; Rust/Tauri 2.11 with `rusqlite`; `@tauri-apps/plugin-clipboard-manager`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-opener`.

**Spec:** `docs/superpowers/specs/2026-08-14-context-menus-design.md` — read it before starting any task. The plan argues from it and does not repeat its reasoning.

## Global Constraints

Every task's requirements implicitly include all of these. Each is copied verbatim from an existing binding rule in this repo.

- **Run `npm install` inside the worktree before anything else.** Without it three suites fail on Vite's `server.fs.allow` with `Error: Denied ID D:/Code/mtg-grimoire/node_modules/mana-font/css/mana.css?raw`, and it reads as a regression you just caused. It is not.
- **Never run two `npm run verify` at once.** Concurrent runs fake ~18 Rust schema failures. Suspect this before debugging SQLite.
- **`npm run verify`'s exit code lies through a pipe.** `| tail` reports tail's 0 while tests fail. Redirect to a file and read the summary.
- **Z-indexes come from `LAYER` in `src/lib/layers.ts` and nowhere else.** `src/lib/layers.test.ts` sweeps `src/` to keep it that way.
- **Timings come from a preset in `src/lib/motion.ts`.** Import `popup`/`dialog`/`scrim`, never a number.
- **Two `motion` APIs are forbidden:** `AnimatePresence mode="popLayout"` and `animateView()`. Both append a `<style>` to `document.head`, which `style-src 'self'` blocks, and the failure is **silent**. `mode="sync"` and `"wait"` are fine.
- **Tailwind scans source text for whole class names.** A class built by interpolation emits no rule at all. Write variants and widths out whole.
- **`aria-disabled`, never the `disabled` attribute**, on anything that greys — a `disabled` button leaves the tab order.
- **Dim text is `text-dim`, never `text-muted`.** `src/lib/tokens.test.ts` guards it.
- **Every option list is drawn through `sortOptions` in `src/lib/options.ts`** — alphabetical by display label. **Exempt:** deck categories (an order the reader arranged themselves). The folder tree keeps its own tree order.
- **Adding a dependency with permissions means adding its narrowest permission, never its `:default`.**
- **`src/lib/ipc.ts` is a hand-written mirror of the Rust structs** and can drift silently. `invoke` matches argument names, and a typo is a runtime rejection — `ipc.test.ts` pins the argument names.
- **Anything `fixed` positioned from a measured rect takes its viewport size from `document.documentElement.clientWidth`/`clientHeight`, never `window.innerWidth`.** In jsdom `clientWidth` is a hard `0` on every element, so a test must state a viewport width itself — and must not state it as `window.innerWidth`, which is the buggy expression.
- **`.storybook/fake/db.ts` must be opened with Read, not Grep.** ripgrep classifies it as binary, so "no matches" there is a lie.
- **Commit style:** `feat:` / `fix:` / `chore:` / `test:` / `docs:`, small, one per task minimum. End every commit message with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Tests run once, at the end, after fan-in.** Do not run `npm run verify` inside a task that is part of a parallel batch — your slice compiles against a tree your siblings are still changing. Report what you changed; the controller runs verify.
- **Story `play` functions cannot be run during a fan-out** — `stories.test.tsx` collects the whole tree. Write them; the controller runs them in a fix round.

---

## File Structure

**New**

| File | Responsibility |
| --- | --- |
| `src/components/menu/types.ts` | The `MenuItem` union and `MenuTarget` types. No React. |
| `src/components/menu/ContextMenuProvider.tsx` | The single root host: open/close state, the context, the document-level `contextmenu` suppressor. |
| `src/components/menu/ContextMenu.tsx` | One menu panel: rows, positioning, keyboard, dismissal. |
| `src/components/menu/Submenu.tsx` | A child panel and the cascade's open/close and flip. |
| `src/components/menu/useContextMenu.ts` | `useContextMenu()` — the hook a surface calls to get an `onContextMenu` handler. |
| `src/lib/clipboard.ts` | `copyText(s)`. The only place the clipboard is named. |
| `src/lib/externalLinks.ts` | `scryfallCardUrl`, `marketplaceSearchUrl`, `openExternal`. Pure URL building plus one opener call. |
| `src/features/card/cardMenu.tsx` | Builds the card `MenuItem[]` from a `CardMenuTarget`. |
| `src/features/decks/deckMenu.tsx` | The deck gallery tile's menu. |
| `src/features/decks/folderMenu.tsx` | The folder row's menu. |
| `src/features/decks/categoryMenu.tsx` | The category heading's menu. |
| `src/features/decks/export/format.ts` | Pure: `(cards, format) => string`. No React, no IPC. |
| `src/features/decks/export/ExportDialog.tsx` | Format picker, preview, Copy, Save as… |
| `src-tauri/src/export.rs` | `export_write_file`. |

**Modified**

| File | Change |
| --- | --- |
| `src/lib/useDismissOnEscape.ts` | A module-level stack of capture-phase layers. |
| `src/lib/store.ts` | `pendingCardSearch` + its two actions. |
| `src/lib/ipc.ts` | Three commands. |
| `src/features/search/useCardSearch.ts` | `oracleId` state, intent consumption. |
| `src/App.tsx` | Wrap in `ContextMenuProvider`. |
| `src-tauri/src/search.rs` | `oracle_id` on `SearchRequest`, `card_image_uri`. |
| `src-tauri/src/filters.rs` | `oracle_id` on `CardFilters`. |
| `src-tauri/src/lib.rs` | Register two commands, add the plugin. |
| `src-tauri/capabilities/default.json` | Two permission lines. |
| `src-tauri/Cargo.toml` · `package.json` | The clipboard plugin. |
| `.storybook/fake/db.ts` | The three new commands. |
| Ten card surfaces + deck tile + folder row + category heading | One `onContextMenu` each. |

---

## Task Order

Tasks 1–8 are **independent** and may run in parallel — no two touch the same file.
Task 9 depends on 4. Tasks 10–12 depend on 4, 6, 7. Tasks 13–15 depend on 10–12.
Tasks 16–18 are the controller's fan-in.

```
1  Rust: oracleId filter
2  Rust: card_image_uri            ┐
3  Rust: export_write_file + caps  ├─ parallel batch A
4  Menu model + Escape depth       │
6  clipboard.ts + externalLinks.ts │
7  export/format.ts                │
9  store + useCardSearch          ─┘   (9 needs nothing from 4; it is store-only)

5  ContextMenu panel + provider    ← needs 4
8  ExportDialog                    ← needs 7

10 cardMenu    ┐
11 deckMenu + folderMenu ├─ parallel batch B, need 4/5/6/7
12 categoryMenu┘

13 surfaces: search, collection, wishlist   ┐
14 surfaces: deck editor views + panel      ├─ parallel batch C, need 10–12
15 surfaces: card pane, printings, tile,    │
   folder row, category heading             ┘

16 Storybook fake + stories      ← controller
17 Docs                          ← controller
18 verify + live CDP pass        ← controller
```

---

### Task 1: Rust — the `oracleId` search filter

**Files:**
- Modify: `src-tauri/src/filters.rs` (the `CardFilters` struct and `push_card_filters`)
- Modify: `src-tauri/src/search.rs` (the `SearchRequest` struct and where it builds `CardFilters`)
- Test: inline `#[cfg(test)]` in `src-tauri/src/search.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `SearchRequest.oracle_id: Option<String>`, serialised as `oracleId`. Absent means unset.

**Context you need:** `cards.oracle_id` is NULLABLE in the schema and **no live row is null** — 0 of 116,590, reversible printings included, because `card_row` falls back to `card_faces[0]`. `idx_cards_oracle ON cards(oracle_id)` **already exists** in `schema::CARDS_INDEXES`, so this filter is indexed for free — do not add an index.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/search.rs`'s `#[cfg(test)] mod tests`. Follow the fixture style already in that module (find an existing test that inserts rows into `cards` and copy its setup helper verbatim rather than inventing one).

```rust
#[test]
fn an_oracle_id_filter_answers_only_that_cards_printings() {
    let state = fixture_with_cards(&[
        ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161"),
        ("bolt-4ed", "o-bolt", "Lightning Bolt", "4ed", "209"),
        ("shock-m21", "o-shock", "Shock", "m21", "159"),
    ]);
    let req = SearchRequest {
        oracle_id: Some("o-bolt".into()),
        limit: Some(50),
        ..Default::default()
    };
    let page = search_cards_inner(&state, req).unwrap();
    assert_eq!(page.total, 2, "both Bolt printings, and no Shock");
    assert!(page.items.iter().all(|c| c.name == "Lightning Bolt"));
}

#[test]
fn no_oracle_id_filter_is_no_filter() {
    let state = fixture_with_cards(&[
        ("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161"),
        ("shock-m21", "o-shock", "Shock", "m21", "159"),
    ]);
    let req = SearchRequest { limit: Some(50), ..Default::default() };
    assert_eq!(search_cards_inner(&state, req).unwrap().total, 2);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd src-tauri && cargo test an_oracle_id_filter`
Expected: FAIL — `SearchRequest` has no field `oracle_id`.

- [ ] **Step 3: Add the field to `CardFilters`**

In `src-tauri/src/filters.rs`, inside `pub struct CardFilters`, beside `set_code`:

```rust
    /// Narrow to every printing of one oracle card — the card, not the cardboard.
    ///
    /// The exact-card filter the search has never had: `text` is FTS **prefix** matching, so
    /// a name query answers other cards too. Indexed for free by `idx_cards_oracle`, which
    /// `CARDS_INDEXES` has carried since schema v1.
    ///
    /// `cards.oracle_id` is NULLABLE and no live row is null, so this needs no null branch.
    pub oracle_id: Option<String>,
```

- [ ] **Step 4: Push the predicate**

In `push_card_filters` in the same file, beside the `set_code` arm and in the same style:

```rust
    if let Some(oracle_id) = &f.oracle_id {
        p.push("c.oracle_id = ?".into(), Box::new(oracle_id.clone()));
    }
```

Match the surrounding code's placeholder convention exactly — read the neighbouring arms first; if they number their placeholders (`?1`, `?2`) rather than using bare `?`, follow that instead.

- [ ] **Step 5: Add the field to `SearchRequest` and thread it through**

In `src-tauri/src/search.rs`, inside `pub struct SearchRequest`, beside `set_code`:

```rust
    /// Every printing of one oracle card. Absent means unset, like every other filter here;
    /// it ANDs with the rest. See [`crate::filters::CardFilters::oracle_id`].
    pub oracle_id: Option<String>,
```

Then find where `SearchRequest` is turned into a `CardFilters` and add `oracle_id: req.oracle_id.clone()` — or the move, matching whatever the neighbouring fields do.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd src-tauri && cargo test oracle_id`
Expected: PASS, both tests.

- [ ] **Step 7: Confirm the index is actually used**

Add one more test:

```rust
#[test]
fn the_oracle_id_filter_uses_its_index() {
    let state = fixture_with_cards(&[("bolt-lea", "o-bolt", "Lightning Bolt", "lea", "161")]);
    let conn = state.db_read.lock().unwrap();
    let plan: String = conn
        .prepare("EXPLAIN QUERY PLAN SELECT id FROM cards c WHERE c.oracle_id = ?1")
        .unwrap()
        .query_row(["o-bolt"], |r| r.get(3))
        .unwrap();
    assert!(
        plan.contains("idx_cards_oracle"),
        "the filter must ride the index CARDS_INDEXES already carries, not scan: {plan}"
    );
}
```

Run: `cd src-tauri && cargo test the_oracle_id_filter_uses_its_index`
Expected: PASS. If it fails on the lock API, read how neighbouring tests reach `db_read` and copy that.

- [ ] **Step 8: `cargo fmt` and clippy**

Run: `cd src-tauri && cargo fmt && cargo clippy -- -D warnings`
Expected: no output from fmt, no warnings from clippy. **`npm run verify` does not run `cargo fmt`** — CI's Linux rust job does, and it is the only red you can get with both suites green.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/filters.rs src-tauri/src/search.rs
git commit -m "feat(search): filter by oracle id

The exact-card filter the search has never had. `text` is FTS prefix
matching, so a name query answers other cards; this rides
idx_cards_oracle, which CARDS_INDEXES has carried since schema v1.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Rust — `card_image_uri`

**Files:**
- Modify: `src-tauri/src/search.rs` (or `card.rs` — put it beside `card_detail` if that reads more naturally; state which you chose)
- Modify: `src-tauri/src/lib.rs` (register it)
- Test: inline `#[cfg(test)]` beside the command

**Interfaces:**
- Consumes: nothing.
- Produces: command `card_image_uri`, args `{ cardId: string, variant: string }`, returns `Option<String>`.

**Context you need:** `cards.image_uris` holds a JSON object with exactly four keys — `thumb`, `grid`, `display`, `art` (`schema::IMAGE_VARIANTS`) — and **a variant the source lacked is written as JSON `null`**, so a present key is not a present URL. The column itself is `NULL` when the card carried no `image_uris` at all. Reads go through `AppState.db_read`, never the write connection. This is **not** `raw`, so no `json_raw` gzip guard is needed.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn the_image_uri_command_answers_the_variant_asked_for() {
    let state = fixture_with_image_uris(
        "bolt-lea",
        r#"{"thumb":"https://cards.scryfall.io/thumb/x.webp?1",
            "grid":"https://cards.scryfall.io/grid/x.webp?1",
            "display":"https://cards.scryfall.io/display/x.webp?1",
            "art":"https://cards.scryfall.io/art/x.webp?1"}"#,
    );
    let got = card_image_uri_inner(&state, "bolt-lea", "display").unwrap();
    assert_eq!(got.as_deref(), Some("https://cards.scryfall.io/display/x.webp?1"));
}

#[test]
fn a_json_null_variant_is_none_rather_than_the_string_null() {
    let state = fixture_with_image_uris("odd", r#"{"thumb":null,"grid":null,"display":null,"art":null}"#);
    assert_eq!(card_image_uri_inner(&state, "odd", "display").unwrap(), None);
}

#[test]
fn a_card_with_no_image_uris_column_is_none() {
    let state = fixture_with_no_image_uris("artless");
    assert_eq!(card_image_uri_inner(&state, "artless", "display").unwrap(), None);
}

#[test]
fn an_unknown_card_is_none_rather_than_an_error() {
    let state = fixture_with_no_image_uris("artless");
    assert_eq!(card_image_uri_inner(&state, "nobody", "display").unwrap(), None);
}

#[test]
fn an_unknown_variant_is_refused_rather_than_interpolated() {
    let state = fixture_with_image_uris("bolt-lea", r#"{"display":"u"}"#);
    assert!(card_image_uri_inner(&state, "bolt-lea", "png").is_err());
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test card_image_uri`
Expected: FAIL — no such function.

- [ ] **Step 3: Implement**

```rust
/// The Scryfall CDN URL for one printing at one size, or `None`.
///
/// **A command rather than a field on five list DTOs.** These URLs are ~100 bytes each and
/// are wanted on a deliberate user act — one menu press — so putting them on `CardSummary`,
/// `DeckCard`, `CollectionRow`, `WishRow` and `Printing` would pay for them on every row of
/// every list to serve a press that mostly never happens.
///
/// Three ways to `None`, and all three are answers rather than faults: the card is unknown,
/// its `image_uris` column is NULL (it carried none), or the variant is JSON `null` — which
/// `card_row::webp_uris` writes for a variant the source lacked, so a present key is not a
/// present URL.
///
/// The variant is checked against [`crate::schema::IMAGE_VARIANTS`] and **never
/// interpolated**: it reaches SQL as a `json_extract` path, so an unchecked one is an
/// injection point. There are four; `png` is not among them, because the ingest keeps four
/// of Scryfall's eleven image keys and drops the legacy JPG/PNG family its own docs mark as
/// replaced.
#[tauri::command]
pub fn card_image_uri(
    state: tauri::State<'_, AppState>,
    card_id: String,
    variant: String,
) -> Result<Option<String>, String> {
    card_image_uri_inner(&state, &card_id, &variant)
}

fn card_image_uri_inner(
    state: &AppState,
    card_id: &str,
    variant: &str,
) -> Result<Option<String>, String> {
    if !crate::schema::IMAGE_VARIANTS.contains(&variant) {
        return Err(format!("unknown image variant: {variant}"));
    }
    let conn = state.db_read.lock().map_err(|e| e.to_string())?;
    let uri: Option<String> = conn
        .query_row(
            "SELECT json_extract(image_uris, '$.' || ?2) FROM cards WHERE id = ?1",
            rusqlite::params![card_id, variant],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?
        .flatten();
    Ok(uri)
}
```

Read the neighbouring commands first and match their `AppState` access, error type and locking exactly — the snippet above is the shape, not necessarily the spelling this crate uses. `.optional()` needs `use rusqlite::OptionalExtension;`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd src-tauri && cargo test card_image_uri`
Expected: PASS, all five.

- [ ] **Step 5: Register the command**

In `src-tauri/src/lib.rs`'s `tauri::generate_handler![…]`, beside `card::card_printings`:

```rust
            card::card_image_uri,
```

(Use whatever module path you put it in.)

- [ ] **Step 6: fmt, clippy, commit**

```bash
cd src-tauri && cargo fmt && cargo clippy -- -D warnings && cd ..
git add src-tauri/src
git commit -m "feat(cards): card_image_uri, the Scryfall CDN URL on request

A command rather than a field on five list DTOs: these are ~100 bytes
each and wanted on one menu press, so a field would pay for them on
every row of every list. The variant is checked against IMAGE_VARIANTS
and never interpolated -- it reaches SQL as a json_extract path.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Rust — `export_write_file`, plus the two capability lines and the clipboard plugin

**Files:**
- Create: `src-tauri/src/export.rs`
- Modify: `src-tauri/src/lib.rs` (`mod export;`, register the command, add the clipboard plugin)
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/Cargo.toml`, `package.json`
- Test: inline `#[cfg(test)]` in `export.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: command `export_write_file`, args `{ path: string, contents: string }`, returns `()`.

**Context you need, and it is the whole reason this task exists:** `dialog:allow-save` returns a **path** and nothing more. Writing bytes at it from the webview would need an `fs:` permission, and **this app grants none anywhere, deliberately** — `src-tauri/CLAUDE.md` records that `tauri-plugin-fs` is in `Cargo.lock` transitively and is unreachable because no `fs:` permission exists. The app already has the pattern: `deck_set_cover_image` takes a path and Rust opens the file, "so no filesystem permission of any kind is needed". Read that command before writing this one.

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn it_writes_the_text_it_was_given() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deck.txt");
    write_export(path.to_str().unwrap(), "1 Lightning Bolt\n2 Shock\n").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "1 Lightning Bolt\n2 Shock\n");
}

#[test]
fn it_overwrites_rather_than_appending() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("deck.txt");
    write_export(path.to_str().unwrap(), "old").unwrap();
    write_export(path.to_str().unwrap(), "new").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
}

#[test]
fn a_path_in_a_directory_that_does_not_exist_is_an_error_not_a_panic() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nope").join("deck.txt");
    assert!(write_export(path.to_str().unwrap(), "x").is_err());
}
```

`tempfile` is already a dev-dependency of this crate — check `Cargo.toml` and add it under `[dev-dependencies]` only if it is genuinely absent.

- [ ] **Step 2: Run to verify they fail**

Run: `cd src-tauri && cargo test write_export`
Expected: FAIL — no module `export`.

- [ ] **Step 3: Write `src-tauri/src/export.rs`**

```rust
//! Writing an export to a file the reader named.
//!
//! **Why Rust writes it rather than the page.** `dialog:allow-save` answers a *path* and
//! nothing more; writing bytes at that path from the webview would need an `fs:` permission,
//! and this app grants none anywhere on purpose — `tauri-plugin-fs` is in `Cargo.lock`
//! transitively and is unreachable because the ACL would deny it. `deck_set_cover_image`
//! established the pattern in the other direction: the page asks for a name and Rust opens
//! the file, so no filesystem permission of any kind is needed.
//!
//! There is no path fence here and none is owed. The path is one the reader picked in the
//! OS's own save dialog a moment earlier — the same trust `deck_set_cover_image` places in
//! the open dialog's answer — and a fence would only ever refuse a directory they chose.

/// Write `contents` at `path`, replacing whatever was there.
///
/// Truncating rather than appending: the reader picked this name in a save dialog that had
/// already asked them about overwriting.
#[tauri::command]
pub fn export_write_file(path: String, contents: String) -> Result<(), String> {
    write_export(&path, &contents)
}

fn write_export(path: &str, contents: &str) -> Result<(), String> {
    std::fs::write(path, contents).map_err(|e| format!("could not write {path}: {e}"))
}
```

- [ ] **Step 4: Register it**

In `src-tauri/src/lib.rs`, add `mod export;` beside the other module declarations, and `export::export_write_file,` inside `generate_handler![…]`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd src-tauri && cargo test write_export`
Expected: PASS, all three.

- [ ] **Step 6: Add the clipboard plugin**

`src-tauri/Cargo.toml`, beside `tauri-plugin-dialog`:

```toml
tauri-plugin-clipboard-manager = "2"
```

`src-tauri/src/lib.rs`, beside the other three `.plugin(...)` registrations:

```rust
        .plugin(tauri_plugin_clipboard_manager::init())
```

`package.json` dependencies, beside `@tauri-apps/plugin-opener`:

```json
    "@tauri-apps/plugin-clipboard-manager": "^2",
```

Then run `npm install` so `package-lock.json` is updated in the same commit.

- [ ] **Step 7: Add exactly two permission lines**

`src-tauri/capabilities/default.json` — add these two and **nothing else**. Not `dialog:default` (five commands), not `clipboard-manager:default` (which includes `allow-read-text`; nothing here reads the clipboard).

```json
    "dialog:allow-save",
    "clipboard-manager:allow-write-text",
```

- [ ] **Step 8: Update the capability test**

`src-tauri/src` has a test asserting what the shipped capability grants — find it (search for `dialog:allow-open` in the crate's tests) and extend it to expect the two new entries and to assert the absences: no `fs:` permission of any kind, and no `clipboard-manager:allow-read-text`. If no such test exists, write one:

```rust
#[test]
fn the_capability_grants_two_new_narrow_permissions_and_no_filesystem() {
    let caps = include_str!("../capabilities/default.json");
    assert!(caps.contains("\"dialog:allow-save\""));
    assert!(caps.contains("\"clipboard-manager:allow-write-text\""));
    // The whole reason `export_write_file` exists. See `export.rs`.
    assert!(!caps.contains("\"fs:"), "no fs: permission is granted anywhere, deliberately");
    // Nothing in this app reads the clipboard.
    assert!(!caps.contains("allow-read-text"));
    // Never a :default -- dialog's is five commands, clipboard's includes the read.
    assert!(!caps.contains("dialog:default"));
    assert!(!caps.contains("clipboard-manager:default"));
}
```

- [ ] **Step 9: Run, fmt, clippy**

Run: `cd src-tauri && cargo test && cargo fmt && cargo clippy -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 10: Commit**

```bash
git add src-tauri package.json package-lock.json
git commit -m "feat(export): export_write_file, and two narrow permissions

dialog:allow-save answers a path and nothing more; writing at it from
the webview would need an fs: permission this app grants nowhere. Rust
writes the file instead -- the pattern deck_set_cover_image already
established. Clipboard gets allow-write-text and not the read.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The menu model, and the Escape depth

**Files:**
- Create: `src/components/menu/types.ts`
- Modify: `src/lib/useDismissOnEscape.ts`
- Test: `src/lib/useDismissOnEscape.test.ts` (**add** to it — do not edit the two existing tests)

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// src/components/menu/types.ts
export type MenuItem =
  | MenuAction | MenuRadio | MenuSubmenu | MenuLazy | MenuSeparator;

export interface MenuAction {
  kind: "action";
  id: string;
  label: string;
  Icon?: LucideIcon;
  disabled?: boolean;
  /** Drawn beside a disabled row, in `text-dim`. Why it cannot be pressed. */
  reason?: string;
  onSelect: () => void;
}
export interface MenuRadio {
  kind: "radio"; id: string; label: string; Icon?: LucideIcon;
  checked: boolean; onSelect: () => void;
}
export interface MenuSubmenu {
  kind: "submenu"; id: string; label: string; Icon?: LucideIcon; items: MenuItem[];
}
export interface MenuLazy {
  kind: "lazy"; id: string; label: string; Icon?: LucideIcon;
  Content: ComponentType<{ onDone: () => void }>;
}
export interface MenuSeparator { kind: "separator"; id: string }

export interface MenuPosition { x: number; y: number }
export function isSelectable(i: MenuItem): boolean;  // false for separator and disabled action
```

**Context you need:** `useDismissOnEscape` orders exactly two rungs today and its own doc says two `"inner"` peers "are not ordered by it at all: both would consume the same press and both would close." `src/features/decks/CLAUDE.md` already prescribes the fix in as many words: *"a depth in `useDismissOnEscape`, not a second `"inner"` and a hope."* Read the whole hook before touching it.

**The acceptance criterion for this task is that the two existing tests in `useDismissOnEscape.test.ts` and `App.test.tsx`'s Escape-stack test pass with no edit.** If you find yourself editing one, you have changed behaviour you were meant to preserve.

- [ ] **Step 1: Write `src/components/menu/types.ts`**

The full union above, with a doc comment on each member. On `MenuLazy`, say why it exists:

```ts
/**
 * A submenu whose contents are a component, mounted only when the row is expanded.
 *
 * **This is the kind that keeps a right-click free.** `submenu` holds items already in hand;
 * `lazy` is for anything that would reach the backend — the folder/deck tree behind
 * "Add to → Deck", the deck's tag list behind "Tag card". Its `Content` runs its own hooks,
 * so `useDecks()` and `deck_tag_list` fire when the reader expands the row and never when the
 * menu merely opens.
 */
```

And `isSelectable`:

```ts
/** Whether the caret may land on this row. A separator never; a disabled action never — but
 *  a disabled action is still *drawn*, because the greyed commander item exists to be read. */
export function isSelectable(item: MenuItem): boolean {
  if (item.kind === "separator") return false;
  if (item.kind === "action") return item.disabled !== true;
  return true;
}
```

- [ ] **Step 2: Write the failing tests for the depth**

**Append** to `src/lib/useDismissOnEscape.test.ts`. Do not touch what is there.

```ts
it("gives the press to the most recently mounted capture layer, not the first", () => {
  const first = vi.fn();
  const second = vi.fn();
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

  fireEvent.keyDown(window, { key: "Escape" });

  // Two `"inner"` peers used to both consume one press. The stack orders them.
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

it("hands the press back down when the top layer unmounts", () => {
  const first = vi.fn();
  const second = vi.fn();
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: first }));
  const top = renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: second }));

  top.unmount();
  fireEvent.keyDown(window, { key: "Escape" });

  expect(first).toHaveBeenCalledTimes(1);
});

it("still lets an inner layer beat an outer one whatever the mount order", () => {
  const outer = vi.fn();
  const inner = vi.fn();
  // The outer layer mounts *second* here — the pane-then-popup order is covered above; this
  // is the reverse, which registration order alone would get wrong.
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: inner }));
  renderHook(() => useDismissOnEscape({ layer: "outer", onDismiss: outer }));

  fireEvent.keyDown(window, { key: "Escape" });

  expect(inner).toHaveBeenCalledTimes(1);
  expect(outer).not.toHaveBeenCalled();
});

it("a disabled layer is not on the stack", () => {
  const enabled = vi.fn();
  const disabled = vi.fn();
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: enabled }));
  renderHook(() => useDismissOnEscape({ layer: "inner", onDismiss: disabled, enabled: false }));

  fireEvent.keyDown(window, { key: "Escape" });

  expect(enabled).toHaveBeenCalledTimes(1);
  expect(disabled).not.toHaveBeenCalled();
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/useDismissOnEscape.test.ts`
Expected: the four new tests FAIL (both peers called), the existing ones PASS.

- [ ] **Step 4: Implement the stack**

In `src/lib/useDismissOnEscape.ts`, above the hook:

```ts
/**
 * The capture-phase layers currently listening, innermost last.
 *
 * **The depth this hook's doc has always owed.** Two `window` capture listeners for one event
 * run in *registration* order, so two `"inner"` peers both consumed one press and both closed
 * — which was survivable while at most one was ever open, and stopped being survivable when a
 * context menu became a thing that opens *over* an already-open dialog.
 *
 * A token per registration rather than the callback itself: two layers may legitimately share
 * one `onDismiss` identity (a memoised close handed to a pair of popups), and a stack keyed on
 * the function would then pop the wrong one.
 *
 * Module-level and therefore shared across a test file's renders — `stack.length = 0` is not
 * needed in a teardown, because every entry is removed by its own effect cleanup.
 */
const captureStack: symbol[] = [];
```

Then inside the hook:

```ts
export function useDismissOnEscape({ layer, onDismiss, enabled = true }: {…}): void {
  useEffect(() => {
    if (!enabled) return;
    const capture = layer === "inner";
    // Identity for this registration, minted per mount so two layers sharing one `onDismiss`
    // are still two entries.
    const token = Symbol("dismissLayer");
    if (capture) captureStack.push(token);

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Only the innermost capture layer acts. An outer (bubble-phase) layer has no stack to
      // consult: `defaultPrevented` above is still what holds it off, exactly as before.
      if (capture && captureStack[captureStack.length - 1] !== token) return;
      e.preventDefault();
      onDismiss();
    };

    window.addEventListener("keydown", onKey, capture);
    return () => {
      window.removeEventListener("keydown", onKey, capture);
      const at = captureStack.lastIndexOf(token);
      if (at !== -1) captureStack.splice(at, 1);
    };
  }, [enabled, layer, onDismiss]);
}
```

- [ ] **Step 5: Update the hook's doc comment**

Replace the paragraph beginning "**This does not generalise to two `"inner"` peers.**" with the truth, keeping the rest of the doc — the capture/bubble reasoning above it is still exactly right and still load-bearing:

```
 * **Two `"inner"` peers are ordered now, by a stack rather than by registration order.**
 * Every capture-phase layer pushes a token on mount and pops it on unmount, and only the
 * token on top acts. A lone `"inner"` layer is a stack of one and behaves exactly as it did.
 * This is what lets a context menu open over a dialog opened over the card pane and give one
 * press to each: menu, dialog, pane.
 *
 * The bubble rung is untouched. An `"outer"` layer still consults nothing but
 * `defaultPrevented`, which is all it needs — every capture listener runs before it.
```

- [ ] **Step 6: Run the whole file plus the app's Escape stack**

Run: `npx vitest run src/lib/useDismissOnEscape.test.ts src/App.test.tsx`
Expected: PASS, **with no edit to any pre-existing test**. If `App.test.tsx` goes red, the stack is wrong — do not edit that test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/useDismissOnEscape.ts src/lib/useDismissOnEscape.test.ts src/components/menu/types.ts
git commit -m "feat(menu): the MenuItem model, and a depth in useDismissOnEscape

Two \"inner\" peers both consumed one press and both closed, which the
hook's own doc admitted and decks/CLAUDE.md already prescribed the fix
for. Capture layers now push a token and only the top one acts; a lone
inner layer is a stack of one and is unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: The menu panel and its provider

**Depends on:** Task 4.

**Files:**
- Create: `src/components/menu/ContextMenu.tsx`, `src/components/menu/Submenu.tsx`, `src/components/menu/ContextMenuProvider.tsx`, `src/components/menu/useContextMenu.ts`
- Modify: `src/App.tsx`
- Test: `src/components/menu/ContextMenu.test.tsx`

**Interfaces:**
- Consumes: `MenuItem`, `MenuPosition`, `isSelectable` from `@/components/menu/types`.
- Produces:

```ts
// useContextMenu.ts
export function useContextMenu(): {
  /** Attach to any element: `onContextMenu={menu(() => buildItems(target))}` */
  menu: (build: () => MenuItem[]) => (e: ReactMouseEvent) => void;
  /** For Shift+F10 / the ContextMenu key. Anchors at the element's bottom-left. */
  menuKey: (build: () => MenuItem[]) => (e: ReactKeyboardEvent) => void;
  openMenu: (items: MenuItem[], at: MenuPosition, opener: HTMLElement | null) => void;
  closeMenu: () => void;
};
```

**Context you need:**

- The provider's menu is a **sibling of `AppShell`**, exactly where `CardZoomIndicator` sits. Read the comment at that line in `App.tsx` — `LAYER.popup` competes only inside the root stacking context, so a menu mounted inside a view is capped by that view's transformed ancestors, and a menu inside a virtualised row is capped at that row's `LAYER.raised`.
- **Not portalled.** The shipped CSP is `style-src 'self'`; every popper library injects a runtime `<style>` and fails silently (`style.sheet` comes back null).
- **`document.documentElement.clientWidth`/`clientHeight`, never `window.innerWidth`.** Measured in this app at 1280 vs 1265. In jsdom both are `0`, so the test states its own viewport — see the test below.
- Motion: the `popup` preset from `@/lib/motion`, with the transform origin set by whole Tailwind literals (`origin-top-left` / `origin-top-right` / `origin-bottom-left` / `origin-bottom-right`), chosen by which way the panel flipped. A popup that grows from the middle of itself reads as unrelated to its trigger.

- [ ] **Step 1: Write the failing tests**

`src/components/menu/ContextMenu.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ContextMenuProvider } from "./ContextMenuProvider";
import { useContextMenu } from "./useContextMenu";
import type { MenuItem } from "./types";

/**
 * jsdom has no layout engine, so `documentElement.clientWidth` is a hard 0 on every element.
 * A test therefore has to state a viewport itself -- and must not state it as
 * `window.innerWidth`, which is the buggy expression this repo has already pinned once as an
 * expected answer. See src/CLAUDE.md.
 */
function statedViewport(width: number, height: number) {
  vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(width);
  vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(height);
}

function Host({ items }: { items: MenuItem[] }) {
  const { menu } = useContextMenu();
  return <button onContextMenu={menu(() => items)}>target</button>;
}

function open(items: MenuItem[]) {
  render(
    <ContextMenuProvider>
      <Host items={items} />
    </ContextMenuProvider>,
  );
}

beforeEach(() => statedViewport(1280, 800));

describe("ContextMenu", () => {
  it("opens on right-click and suppresses the native menu", async () => {
    const onSelect = vi.fn();
    open([{ kind: "action", id: "copy", label: "Copy card name", onSelect }]);

    const target = screen.getByRole("button", { name: "target" });
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    target.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copy card name" })).toBeInTheDocument();
  });

  it("runs the item and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    open([{ kind: "action", id: "copy", label: "Copy card name", onSelect }]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    await user.click(await screen.findByRole("menuitem", { name: "Copy card name" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("draws a disabled item with its reason, and does not run it", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    open([{
      kind: "action", id: "cmd", label: "Set as commander",
      disabled: true, reason: "not a legendary creature", onSelect,
    }]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    const row = await screen.findByRole("menuitem", { name: /Set as commander/ });
    // aria-disabled and never the `disabled` attribute -- the greyed item exists to be read,
    // so it has to stay in the tab order.
    expect(row).toHaveAttribute("aria-disabled", "true");
    expect(row).not.toHaveAttribute("disabled");
    expect(within(row).getByText("not a legendary creature")).toBeInTheDocument();

    await user.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("moves the caret with the arrows, skipping separators", async () => {
    const user = userEvent.setup();
    open([
      { kind: "action", id: "a", label: "First", onSelect: vi.fn() },
      { kind: "separator", id: "s" },
      { kind: "action", id: "b", label: "Second", onSelect: vi.fn() },
    ]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    // Assert with the keyboard rather than by checking focus after a click: `user.click`
    // focuses what it is handed, so a focus assertion after one proves nothing.
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "Second" })).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("menuitem", { name: "First" })).toHaveFocus();
  });

  it("opens a submenu with ArrowRight and leaves it with ArrowLeft", async () => {
    const user = userEvent.setup();
    open([{
      kind: "submenu", id: "open-on", label: "Open on",
      items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
    }]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.keyboard("{ArrowDown}");
    const parent = screen.getByRole("menuitem", { name: /Open on/ });
    expect(parent).toHaveAttribute("aria-haspopup", "menu");
    expect(parent).toHaveAttribute("aria-expanded", "false");

    await user.keyboard("{ArrowRight}");
    expect(parent).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menuitem", { name: "Scryfall" })).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(parent).toHaveFocus();
  });

  it("closes one level per Escape", async () => {
    const user = userEvent.setup();
    open([{
      kind: "submenu", id: "open-on", label: "Open on",
      items: [{ kind: "action", id: "sf", label: "Scryfall", onSelect: vi.fn() }],
    }]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    await user.keyboard("{ArrowDown}{ArrowRight}");

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menuitem", { name: "Scryfall" })).not.toBeInTheDocument();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("hands focus back to the element that was right-clicked", async () => {
    const user = userEvent.setup();
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    await user.keyboard("{Escape}");
    expect(target).toHaveFocus();
  });

  it("mounts a lazy submenu's content only once it is expanded", async () => {
    const user = userEvent.setup();
    const mounted = vi.fn();
    function Content() { mounted(); return <div role="menuitem" tabIndex={-1}>loaded</div>; }
    open([{ kind: "lazy", id: "deck", label: "Deck", Content }]);
    screen.getByRole("button", { name: "target" })
      .dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");

    // The whole point of the `lazy` kind: opening the menu must not reach the backend.
    expect(mounted).not.toHaveBeenCalled();

    await user.keyboard("{ArrowDown}{ArrowRight}");
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("flips left when it would overflow the stated viewport width", async () => {
    statedViewport(1280, 800);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 1270, clientY: 40 }),
    );

    const panel = await screen.findByRole("menu");
    // Pinned by, and growing from, the corner nearest the pointer -- the app's anchored-popup
    // rule. Written out whole, because Tailwind scans source text for class names.
    expect(panel).toHaveClass("origin-top-right");
    expect(Number.parseFloat(panel.style.left)).toBeLessThan(1270);
  });

  it("flips up when it would overflow the stated viewport height", async () => {
    statedViewport(1280, 800);
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    screen.getByRole("button", { name: "target" }).dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 790 }),
    );

    const panel = await screen.findByRole("menu");
    expect(panel).toHaveClass("origin-bottom-left");
  });

  it("a second right-click replaces rather than stacking", async () => {
    open([{ kind: "action", id: "a", label: "First", onSelect: vi.fn() }]);
    const target = screen.getByRole("button", { name: "target" });
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await screen.findByRole("menu");
    target.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    expect(await screen.findAllByRole("menu")).toHaveLength(1);
  });

  it("leaves the native menu alone inside a text field", () => {
    render(
      <ContextMenuProvider>
        <input aria-label="search" />
      </ContextMenuProvider>,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByLabelText("search").dispatchEvent(event);

    // Cut/copy/paste/undo and spellcheck suggestions, none of which we can rebuild.
    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("suppresses the native menu on plain background with no menu of our own", () => {
    render(
      <ContextMenuProvider>
        <div data-testid="ground" style={{ width: 100, height: 100 }} />
      </ContextMenuProvider>,
    );
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("ground").dispatchEvent(event);

    // A WebView2 menu offering "Reload" and "View source" does not belong in a desktop app.
    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/components/menu/ContextMenu.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write `ContextMenuProvider.tsx`**

Responsibilities, and nothing else:

1. Hold `{ items, at, opener } | null` in state.
2. Expose `openMenu` / `closeMenu` through a context.
3. Register **one** document-level `contextmenu` listener that calls `preventDefault()` unless the target is inside a text field. A surface's own `onContextMenu` runs first (React's root listener is below the document one in the bubble path — verify this in the test above; if the ordering does not hold, register the suppressor with `{ capture: false }` on `document` and have the surface handler call `stopPropagation()` after opening).
4. Render at most one `<ContextMenu>`, inside `<AnimatePresence>`.

The text-field test:

```ts
/**
 * Where WebView2's own menu survives. Cut, copy, paste, undo and spellcheck suggestions are
 * things we cannot rebuild, so a text field keeps the browser's. Everywhere else the native
 * menu is suppressed — an app that offers "Reload" and "View source" on a right-click is
 * leaking browser chrome into a desktop window.
 */
function isTextField(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return el.closest("input, textarea, [contenteditable=''], [contenteditable='true']") !== null;
}
```

- [ ] **Step 4: Write `useContextMenu.ts`**

```ts
/**
 * The one door a surface uses.
 *
 * `menu(build)` returns an `onContextMenu` handler. **`build` is a thunk on purpose**: a
 * surface draws hundreds of rows, and building every row's item list on every render would
 * cost more than the menu ever does. It runs once, when the reader actually right-clicks.
 */
```

`menuKey(build)` handles `Shift+F10` and `e.key === "ContextMenu"`, anchoring at
`e.currentTarget.getBoundingClientRect()`'s bottom-left rather than at a pointer that was
never there.

- [ ] **Step 5: Write `ContextMenu.tsx`**

- `role="menu"`, `aria-orientation="vertical"`, `fixed`, `LAYER.popup`, the `popup` motion preset.
- Position from `at`, measured against `document.documentElement.clientWidth`/`clientHeight`
  after a layout effect reads the panel's own `getBoundingClientRect()`. Flip horizontally
  and vertically independently; pick the origin class from the pair of flips, written out
  whole: `origin-top-left`, `origin-top-right`, `origin-bottom-left`, `origin-bottom-right`.
- Rows: `role="menuitem"` (or `menuitemradio` with `aria-checked` for `kind: "radio"`),
  `tabIndex={-1}`, `aria-disabled` on a disabled action and **never** the `disabled` attribute.
- `reason` is a `<span className="text-dim">` inside the row — `text-dim`, never `text-muted`.
- Keyboard: `ArrowDown`/`ArrowUp` wrap over `isSelectable` rows; `Home`/`End`;
  `ArrowRight`/`Enter` on a submenu or lazy row opens it and moves in; `ArrowLeft` leaves.
  **No type-ahead** — that was decided out of scope.
- `useDismissOnEscape({ layer: "inner", onDismiss })` — one registration per open panel, which
  is what Task 4's stack orders. Escape hands focus back to `opener`.
- Close on: outside `pointerdown`, any ancestor `scroll` (capture, on `window`), `resize`.
  A `fixed` panel positioned from a point that has scrolled away is worse than no panel.

- [ ] **Step 6: Write `Submenu.tsx`**

A child panel anchored to its parent row's right edge, flipping left near the viewport edge by
the same `documentElement.clientWidth` rule. Opens on hover after a short delay, on
`ArrowRight`, and on click; closes on `ArrowLeft`, on Escape (consuming one press), and when
the pointer moves to a different row of the parent. It registers its own
`useDismissOnEscape({ layer: "inner" })`, which is exactly the case Task 4's stack was written
for — the submenu is on top of the menu, and one press closes one of them.

For `kind: "lazy"`, render `<Content onDone={closeWholeMenu} />` and nothing until expanded.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/components/menu/ContextMenu.test.tsx`
Expected: PASS, all thirteen.

- [ ] **Step 8: Mount the provider in `App.tsx`**

Inside `<QueryClientProvider>`, wrapping `<AppShell>` and `<CardZoomIndicator>` both. Add a
comment in the file's established voice:

```tsx
{/* **The provider wraps the shell; the menu it renders is a sibling of it**, for exactly the
    reason `CardZoomIndicator` below is one. A menu takes `LAYER.popup`, a z-index competes
    only inside its own stacking context, and every card surface in this app draws rows that
    are `position: absolute` and transformed — so a menu mounted where it was opened is capped
    at that row's `LAYER.raised` and painted under the table header above it. Mounted here,
    drawn at the pointer. Nothing between here and the root transforms. */}
```

- [ ] **Step 9: Run the app suite**

Run: `npx vitest run src/App.test.tsx src/components/menu`
Expected: PASS. `App.test.tsx` must not need an edit.

- [ ] **Step 10: Commit**

```bash
git add src/components/menu src/App.tsx
git commit -m "feat(menu): the context menu panel, its cascade and its provider

One instance, a sibling of AppShell where CardZoomIndicator sits, for
the same reason: LAYER.popup competes only in the root stacking context
and every card row here is transformed. Hand-positioned against
documentElement.clientWidth -- innerWidth includes the scrollbar and is
15px wrong at 1280. No portal: style-src 'self' blocks every popper.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: `clipboard.ts` and `externalLinks.ts`

**Files:**
- Create: `src/lib/clipboard.ts`, `src/lib/externalLinks.ts`
- Test: `src/lib/externalLinks.test.ts`

**Interfaces:**
- Consumes: `Marketplace` / `MarketplaceId` from `@/lib/marketplace`.
- Produces:

```ts
// clipboard.ts
export async function copyText(text: string): Promise<void>;

// externalLinks.ts
export function scryfallCardUrl(setCode: string, collectorNumber: string): string;
export function marketplaceSearchUrl(id: MarketplaceId, cardName: string): string;
export async function openExternal(url: string): Promise<void>;
```

**Context you need:** **Nothing is fetched, resolved or opened until the reader clicks.** These
are pure string builders plus one `openUrl` call made on selection. `@tauri-apps/plugin-opener`
is already a dependency and already permitted (`opener:default`). The clipboard plugin arrives
in Task 3; if you are running in parallel with it, write the import anyway — `npm install` at
fan-in resolves it.

- [ ] **Step 1: Write the failing tests**

`src/lib/externalLinks.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { marketplaceSearchUrl, scryfallCardUrl } from "./externalLinks";
import { MARKETPLACE_IDS } from "./marketplace";

describe("scryfallCardUrl", () => {
  it("builds the permalink from the set and the collector number", () => {
    expect(scryfallCardUrl("lea", "161")).toBe("https://scryfall.com/card/lea/161");
  });

  it("lowercases the set code", () => {
    // Scryfall's own URLs are lowercase; the corpus stores codes as they arrive.
    expect(scryfallCardUrl("LEA", "161")).toBe("https://scryfall.com/card/lea/161");
  });

  it("escapes a collector number that is not a plain integer", () => {
    // Collector numbers are TEXT, not numbers: "★", "123a" and "S-1" are all real.
    expect(scryfallCardUrl("sld", "1556★")).toBe(
      "https://scryfall.com/card/sld/1556%E2%98%85",
    );
  });
});

describe("marketplaceSearchUrl", () => {
  it("answers a real URL for every marketplace this app knows", () => {
    // Card trader has no price feed we can reach, but its website exists -- and if a new id
    // is ever added to MARKETPLACE_IDS this test is what says the link was forgotten.
    for (const id of MARKETPLACE_IDS) {
      const url = marketplaceSearchUrl(id, "Lightning Bolt");
      expect(() => new URL(url), `${id} must build a valid URL`).not.toThrow();
      expect(url.startsWith("https://"), `${id} must be https`).toBe(true);
    }
  });

  it("percent-encodes the card name rather than pasting it in", () => {
    const url = marketplaceSearchUrl("tcgplayer", "Jinnie Fay // Jinnie Fay");
    expect(url).not.toContain(" ");
    expect(url).not.toContain("//Jinnie");
  });

  it("encodes an apostrophe and an accent", () => {
    const url = marketplaceSearchUrl("cardmarket", "Ach! Hans, Run! Æther");
    expect(() => new URL(url)).not.toThrow();
    expect(url).not.toContain(" ");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/lib/externalLinks.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `externalLinks.ts`**

```ts
/**
 * Where a card can be looked at outside this app.
 *
 * **Every function here builds a string and nothing else.** Nothing is fetched, resolved or
 * opened until the reader presses the item — a menu that merely *offers* to open a
 * marketplace must not have visited one. {@link openExternal} is the single call that leaves
 * the app, and it is made on selection.
 *
 * **The Scryfall link is derived rather than stored.** The canonical `scryfall_uri` lives only
 * inside the gzipped `raw` blob, and `scryfall.com/card/<set>/<number>` is a documented
 * permalink built from two fields every surface in this app already holds — so a wishlist row
 * and a deck card get the same link a search result does, with no DTO change and no round
 * trip.
 *
 * **A marketplace link is a search, not a product page.** None of the four priced sites
 * publishes a per-card URL derivable from what this app stores, so the honest thing to offer
 * is that site's search for the card's name.
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import type { MarketplaceId } from "./marketplace";

export function scryfallCardUrl(setCode: string, collectorNumber: string): string {
  // Collector numbers are TEXT in Scryfall's data, not integers -- "1556★", "123a" and "S-1"
  // are all real, and a raw ★ in a path is not a URL.
  return `https://scryfall.com/card/${setCode.toLowerCase()}/${encodeURIComponent(collectorNumber)}`;
}

/**
 * One search URL per marketplace, keyed by name.
 *
 * A `Record` rather than a `switch`, so adding a marketplace to `MARKETPLACE_IDS` without a
 * link here is a **type error** rather than a menu item that opens nothing.
 */
const SEARCH_URL: Record<MarketplaceId, (q: string) => string> = {
  tcgplayer: (q) => `https://www.tcgplayer.com/search/magic/product?q=${q}`,
  cardmarket: (q) => `https://www.cardmarket.com/en/Magic/Products/Search?searchString=${q}`,
  cardkingdom: (q) => `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${q}`,
  manapool: (q) => `https://manapool.com/search?q=${q}`,
  // No price feed this app can reach -- its API needs a per-user JWT and publishes no bulk
  // download -- but the website exists, and a reader looking for it deserves the link.
  cardtrader: (q) => `https://www.cardtrader.com/en/search?q=${q}`,
};

export function marketplaceSearchUrl(id: MarketplaceId, cardName: string): string {
  return SEARCH_URL[id](encodeURIComponent(cardName));
}

/** The one call that leaves the app. Made on selection and never before it. */
export async function openExternal(url: string): Promise<void> {
  await openUrl(url);
}
```

**Verify each of those five URL shapes against the live site before committing** — open one by hand for Lightning Bolt. A link that 404s is a menu item that lies, and no test here can catch it.

- [ ] **Step 4: Write `clipboard.ts`**

```ts
/**
 * The only place this app names the clipboard.
 *
 * `tauri-plugin-clipboard-manager` rather than `navigator.clipboard`, deliberately. The web
 * API *should* work — `http://tauri.localhost` is a subdomain of localhost and therefore a
 * secure context — but nothing in this app had ever proved it, and the failure mode would be
 * the packaged exe only: green in dev, green in Storybook, green in jsdom, silent in the
 * shipped window. The plugin costs one narrow permission (`clipboard-manager:allow-write-text`,
 * and not the read) and removes the class of surprise entirely.
 *
 * One function because one direction: nothing in this app reads the clipboard, which is why
 * `allow-read-text` is not granted.
 */
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

export async function copyText(text: string): Promise<void> {
  await writeText(text);
}
```

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/lib/externalLinks.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/clipboard.ts src/lib/externalLinks.ts src/lib/externalLinks.test.ts
git commit -m "feat(links): Scryfall and marketplace URLs, and the clipboard

Every function builds a string; openExternal is the one call that leaves
the app and it is made on selection. The Scryfall link is derived from
setCode + collectorNumber, so a wishlist row gets the same link a search
result does with no DTO change. SEARCH_URL is a Record, so adding a
marketplace without a link is a type error rather than a dead item.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: `export/format.ts`

**Files:**
- Create: `src/features/decks/export/format.ts`
- Test: `src/features/decks/export/format.test.ts`

**Interfaces:**
- Consumes: `DeckCard` from `@/lib/ipc`.
- Produces:

```ts
export const EXPORT_FORMATS = ["plain", "mtgo", "moxfield", "csv"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];
export const EXPORT_FORMAT_LABEL: Record<ExportFormat, string>;
export const EXPORT_FORMAT_EXTENSION: Record<ExportFormat, string>;
/** What a card needs to be exported — a `Pick` of `DeckCard`, so a whole one satisfies it. */
export type ExportCard = Pick<DeckCard, "name" | "quantity" | "setCode" | "collectorNumber">;
export function formatExport(cards: readonly ExportCard[], format: ExportFormat): string;
```

**Context you need:** This is the mirror of `import/parse.ts` — read it first. Two rules there
bind here: **`//` is part of a card name, not a comment, anywhere but the start of a line**
(`Branchloft Pathway // Boulderloft Pathway` is one card, and there are seven such names in the
reference list alone), and the app's line splitter accepts CRLF, lone LF **and lone CR**. What
this file emits must be what that file can read back.

`ExportCard` is a `Pick` rather than a narrowing of `DeckCard`, for the reason `CardIdentity`
is one in `import/plan.ts`: a caller holding a whole `DeckCard` satisfies a `Pick` of it, so no
call site has to build an adapter.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { EXPORT_FORMATS, formatExport, type ExportCard } from "./format";
import { parseDecklist } from "../import/parse";  // check the real export name first

const BOLT: ExportCard = { name: "Lightning Bolt", quantity: 2, setCode: "lea", collectorNumber: "161" };
const PATHWAY: ExportCard = {
  name: "Branchloft Pathway // Boulderloft Pathway",
  quantity: 1, setCode: "znr", collectorNumber: "258",
};

describe("formatExport", () => {
  it("writes plain lines as quantity then name", () => {
    expect(formatExport([BOLT], "plain")).toBe("2 Lightning Bolt\n");
  });

  it("keeps a double-faced name whole in every format", () => {
    // `//` is part of the name anywhere but the start of a line -- seven such names are in
    // the importer's own reference list. Cutting one here is a card the reader loses.
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([PATHWAY], format)).toContain("Branchloft Pathway // Boulderloft Pathway");
    }
  });

  it("names the printing in the MTGO and Moxfield formats", () => {
    expect(formatExport([BOLT], "moxfield")).toBe("2 Lightning Bolt (LEA) 161\n");
    expect(formatExport([BOLT], "mtgo")).toBe("2 Lightning Bolt\n");
  });

  it("writes a CSV with a header row", () => {
    expect(formatExport([BOLT], "csv")).toBe(
      "Quantity,Name,Set,Collector number\n2,Lightning Bolt,lea,161\n",
    );
  });

  it("quotes a CSV field containing a comma or a quote", () => {
    const odd: ExportCard = {
      name: 'Ach! Hans, Run! "the" card', quantity: 1, setCode: "unh", collectorNumber: "1",
    };
    expect(formatExport([odd], "csv")).toContain('"Ach! Hans, Run! ""the"" card"');
  });

  it("ends every format with a trailing newline and uses LF", () => {
    for (const format of EXPORT_FORMATS) {
      const out = formatExport([BOLT, PATHWAY], format);
      expect(out.endsWith("\n")).toBe(true);
      expect(out).not.toContain("\r");
    }
  });

  it("answers an empty list with an empty string, never a stray header", () => {
    for (const format of EXPORT_FORMATS) {
      expect(formatExport([], format)).toBe("");
    }
  });

  it("round-trips through this app's own importer", () => {
    // The only test here that matters in the field: what we write, we must be able to read.
    const text = formatExport([BOLT, PATHWAY], "plain");
    const parsed = parseDecklist(text);
    expect(parsed.issues).toHaveLength(0);
    expect(parsed.lines.map((l) => l.name)).toEqual([
      "Lightning Bolt",
      "Branchloft Pathway // Boulderloft Pathway",
    ]);
    expect(parsed.lines.map((l) => l.quantity)).toEqual([2, 1]);
  });
});
```

**Read `src/features/decks/import/parse.ts` first** and fix the import name, the parsed shape
and the field names in that last test to match what it actually exports. The test is the
requirement; the spelling is that file's.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/export/format.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Pure functions, no React, no hook, no IPC. One `Record<ExportFormat, (cards) => string>` so a
new format is one entry rather than a new branch in four places. CSV escaping: a field is
quoted when it contains a comma, a quote or a newline, and an inner quote is doubled.

Doc the module in the repo's voice, and say what it is the mirror of:

```ts
/**
 * A pile of cards as text.
 *
 * The mirror of `../import/parse.ts`, and bound by that file's rules read backwards: **`//` is
 * part of a card name** (`Branchloft Pathway // Boulderloft Pathway` is one card, and seven
 * such names are in the importer's own reference list), so nothing here may cut one; and what
 * this writes has to be something that parser reads, which is what the round-trip test pins.
 *
 * LF and a trailing newline, always. The parser takes CRLF, a lone LF and a lone CR, so it
 * would read any of them — but a file this app wrote should have one answer, and `\n` is the
 * one every other tool in this space emits.
 *
 * An empty list is an empty string in every format, **CSV included**. A header row over no
 * rows is a file that claims to be a decklist and is not one.
 */
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/features/decks/export/format.test.ts`
Expected: PASS, all eight.

- [ ] **Step 5: Commit**

```bash
git add src/features/decks/export
git commit -m "feat(decks): decklist export formatting

The mirror of import/parse.ts, bound by its rules read backwards -- `//`
is part of a card name and must never be cut, and what this writes the
importer has to read, which the round-trip test pins. Four formats as a
Record, so a fifth is one entry.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: `ExportDialog.tsx`

**Depends on:** Task 7 (and Task 3's `export_write_file` at fan-in; Task 6's `copyText`).

**Files:**
- Create: `src/features/decks/export/ExportDialog.tsx`
- Modify: `src/lib/ipc.ts` (add `exportWriteFile`)
- Test: `src/features/decks/export/ExportDialog.test.tsx`

**Interfaces:**
- Consumes: `formatExport`, `EXPORT_FORMATS`, `EXPORT_FORMAT_LABEL`, `EXPORT_FORMAT_EXTENSION`, `ExportCard` from `./format`; `copyText` from `@/lib/clipboard`; `DeckDialog` from `../DeckDialog`.
- Produces:

```tsx
export interface ExportDialogProps {
  open: boolean;
  /** What is being exported — "Removal", "Atraxa". The dialog's title reads `Export "<title>"`. */
  subject: string;
  /** The cards. **An argument, never something this dialog fetches** — which is what lets a
   *  later deck-level export reuse it whole. */
  cards: readonly ExportCard[];
  /** Seeds the save dialog's file name. */
  suggestedFileName: string;
  onDismiss: () => void;
  onClose: () => void;
}
export function ExportDialog(props: ExportDialogProps): JSX.Element;
```

**Context you need:** Build it **on `DeckDialog`**, the shared modal shell — `src/CLAUDE.md`
says a new modal in the deck surface is built *on* that file rather than beside it, and names
the three that still carry their own copy of the chrome as the ones to move onto it. Do not add
a fourth. `DeckDialog` guarantees closed-is-nothing-mounted, so put the body in its own
component one floor down. `onDismiss` **must be stable** (`useCallback`) — `useDismissOnEscape`
takes it as a dependency.

- [ ] **Step 1: Add the two IPC commands**

In `src/lib/ipc.ts`, beside the neighbouring commands and in their exact style:

```ts
  /**
   * The Scryfall CDN URL for one printing at one size, or `null`.
   *
   * A command rather than a field on the list DTOs, and called **on the press** — see
   * `card_image_uri` in the crate. Three ways to `null`, all of them answers: an unknown
   * card, a card with no `image_uris`, and a variant the source lacked.
   */
  cardImageUri: (cardId: string, variant: ImageVariant) =>
    invoke<string | null>("card_image_uri", { cardId, variant }),
  /**
   * Write an export at a path the reader chose in the OS save dialog.
   *
   * Rust writes the file because `dialog:allow-save` answers a *path* and nothing more, and
   * writing at it from here would need an `fs:` permission this app grants nowhere. Same
   * shape as `deck_set_cover_image`.
   */
  exportWriteFile: (path: string, contents: string) =>
    invoke<void>("export_write_file", { path, contents }),
```

Add the argument names to `ipc.test.ts` alongside the others — `invoke` matches by name and a
typo is a runtime rejection.

- [ ] **Step 2: Write the failing tests**

```tsx
describe("ExportDialog", () => {
  it("previews the plain format by default", async () => {
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    expect(await screen.findByText("2 Lightning Bolt")).toBeInTheDocument();
  });

  it("redraws the preview when the format changes", async () => {
    const user = userEvent.setup();
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    await user.click(await screen.findByRole("radio", { name: "Moxfield" }));
    expect(await screen.findByText("2 Lightning Bolt (LEA) 161")).toBeInTheDocument();
  });

  it("copies the text of the format that is showing", async () => {
    const user = userEvent.setup();
    const copy = vi.mocked(copyText);
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    await user.click(await screen.findByRole("radio", { name: "CSV" }));
    await user.click(screen.getByRole("button", { name: /Copy/ }));
    expect(copy).toHaveBeenCalledWith(
      "Quantity,Name,Set,Collector number\n2,Lightning Bolt,lea,161\n",
    );
  });

  it("writes the file Rust was told to write, at the path the picker answered", async () => {
    const user = userEvent.setup();
    vi.mocked(save).mockResolvedValue("D:\\decks\\Removal.txt");
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).toHaveBeenCalledWith(
      "D:\\decks\\Removal.txt", "2 Lightning Bolt\n",
    );
  });

  it("writes nothing when the picker is cancelled", async () => {
    const user = userEvent.setup();
    // The picker answers null on cancel. Writing to "null" is the bug this pins.
    vi.mocked(save).mockResolvedValue(null);
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(vi.mocked(ipc.exportWriteFile)).not.toHaveBeenCalled();
  });

  it("reports a refused write rather than closing on it", async () => {
    const user = userEvent.setup();
    vi.mocked(save).mockResolvedValue("D:\\decks\\Removal.txt");
    vi.mocked(ipc.exportWriteFile).mockRejectedValue("could not write: access denied");
    const onDismiss = vi.fn();
    render(<ExportDialog open subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={onDismiss} onClose={noop} />);
    await user.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/access denied/);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("mounts nothing while closed", () => {
    render(<ExportDialog open={false} subject="Removal" cards={[BOLT]} suggestedFileName="Removal"
      onDismiss={noop} onClose={noop} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/features/decks/export/ExportDialog.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

- `<DeckDialog open title={`Export "${subject}"`} closeLabel="Close export" width="w-[40rem]" …>`
  — the width written out whole, because Tailwind scans source text.
- Body in its own component, so a closed dialog mounts nothing.
- A radio group over `EXPORT_FORMATS`, labels from `EXPORT_FORMAT_LABEL`. **Not** through
  `sortOptions`: these are four named formats in a deliberate order (plain first, the one most
  readers want), the same kind of exemption a grade scale gets — put the comment at the site.
- The preview is `formatExport(cards, format)` in a `<pre>` inside a scroller, recomputed by a
  `useMemo` on `[cards, format]`.
- Copy → `copyText(text)`, then a `role="status"` line saying so, on the `statusLine` motion
  preset with `overflow-hidden` (the preset animates `height`, and without that class the text
  is fully drawn at zero height for a frame).
- Save as… → `save({ defaultPath: `${suggestedFileName}.${EXPORT_FORMAT_EXTENSION[format]}` })`
  from `@tauri-apps/plugin-dialog`; **`null` means cancelled and writes nothing**; then
  `ipc.exportWriteFile(path, text)`. A refusal becomes a `role="alert"` and the dialog stays
  open — the reader's text is still on screen and still copyable.
- **The file picker's own half is unverifiable**, for the reason `deck_set_cover_image`'s is:
  `dialog:allow-save` opens a native window CDP cannot reach. Path → write is tested; click →
  path is not. Say so in the file's doc, as `import/CLAUDE.md` already says of the open dialog.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/features/decks/export`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks/export src/lib/ipc.ts src/lib/ipc.test.ts
git commit -m "feat(decks): the export dialog

Built on DeckDialog rather than beside it -- src/CLAUDE.md names the
three surfaces still carrying their own chrome as the ones to move onto
it, so this must not be a fourth. The cards are an argument the dialog
never fetches, which is what lets a later deck-level export reuse it
whole. A cancelled picker answers null and writes nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: The search intent in the store, and its consumption

**Files:**
- Modify: `src/lib/store.ts`
- Modify: `src/features/search/useCardSearch.ts`
- Test: `src/lib/store.test.ts` (or wherever the store is tested — find it), `src/features/search/useCardSearch.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:

```ts
// on AppState
pendingCardSearch: { oracleId: string; name: string } | null;
/** Go to Search and show every printing of one card. Sets `activeView` too. */
requestAllPrintings: (target: { oracleId: string; name: string }) => void;
/** Read it once and clear it. Returns null when there is nothing waiting. */
consumePendingCardSearch: () => { oracleId: string; name: string } | null;
```

**Context you need:** `useCardSearch` holds every filter in component-local `useState` inside
`SearchPage`, so nothing outside it can set them. `setActiveView` already clears
`selectedCardId`, `paneDeckContext`, `openDeckId` and `returnToDeckId` — that is the existing
rule and it is what makes navigating away from an open deck safe. `requestAllPrintings` must
set the intent **and** the view in one `set`, or the view change clears state the intent
depends on.

**Consumed on read.** A second visit to Search must not re-apply a filter the reader has since
cleared. This is the same shape as `returnToDeckId`, which `DecksPage` reads and clears once.

- [ ] **Step 1: Write the failing store tests**

```ts
it("requesting all printings sets the intent and goes to search in one write", () => {
  useAppStore.setState({ activeView: "decks", openDeckId: 7 });
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });

  const s = useAppStore.getState();
  expect(s.activeView).toBe("search");
  expect(s.pendingCardSearch).toEqual({ oracleId: "o-bolt", name: "Lightning Bolt" });
  // setActiveView's own rule: leaving the view closes the deck and the card.
  expect(s.openDeckId).toBeNull();
});

it("consuming the intent clears it", () => {
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });

  expect(useAppStore.getState().consumePendingCardSearch())
    .toEqual({ oracleId: "o-bolt", name: "Lightning Bolt" });
  // Read once. A second visit to Search must not re-apply a filter the reader has cleared.
  expect(useAppStore.getState().consumePendingCardSearch()).toBeNull();
  expect(useAppStore.getState().pendingCardSearch).toBeNull();
});
```

- [ ] **Step 2: Write the failing `useCardSearch` tests**

```ts
it("applies a pending intent by clearing every filter and widening the corpus", async () => {
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });
  const { result } = renderHook(() => useCardSearch(), { wrapper });

  act(() => { result.current.setFormat("modern"); });        // the reader's old filter
  await waitFor(() => expect(result.current.oracleId).toBe("o-bolt"));

  expect(result.current.format).toBe("");
  expect(result.current.colors).toEqual([]);
  expect(result.current.sets).toEqual([]);
  expect(result.current.manaValues).toEqual([]);
  expect(result.current.owned).toBeUndefined();
  // "Show me everything that is this card": without these two, a Modern filter hides the
  // Vintage-only printings and playable-only hides the art series.
  expect(result.current.allPrintings).toBe(true);
  expect(result.current.unplayable).toBe(true);
});

it("sends the oracle id to the backend and keys the query on it", async () => {
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });
  renderHook(() => useCardSearch(), { wrapper });

  await waitFor(() => expect(vi.mocked(ipc.searchCards)).toHaveBeenCalledWith(
    expect.objectContaining({ oracleId: "o-bolt", collapse: undefined }),
  ));
});

it("clearing the card filter is Reset all, and it does not come back", async () => {
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });
  const { result } = renderHook(() => useCardSearch(), { wrapper });
  await waitFor(() => expect(result.current.oracleId).toBe("o-bolt"));

  act(() => { result.current.resetAll(); });

  expect(result.current.oracleId).toBe("");
  // The intent was consumed on arrival, so nothing re-applies it a render later.
  await waitFor(() => expect(result.current.oracleId).toBe(""));
});

it("counts the card filter among the active filters", async () => {
  useAppStore.getState().requestAllPrintings({ oracleId: "o-bolt", name: "Lightning Bolt" });
  const { result } = renderHook(() => useCardSearch(), { wrapper });
  await waitFor(() => expect(result.current.activeFilterCount).toBeGreaterThan(0));
});
```

Read `useCardSearch.ts` and its existing test file first; match the wrapper, the mock style and
the returned field names exactly. `oracleId`, `setOracleId` and `oracleName` are new returns —
`oracleName` is what a chip saying "Lightning Bolt ✕" draws.

- [ ] **Step 3: Run to verify they fail**

Run: `npx vitest run src/lib/store.test.ts src/features/search/useCardSearch.test.ts`
Expected: FAIL.

- [ ] **Step 4: Implement the store half**

```ts
  /**
   * A card the reader asked to see every printing of, waiting for Search to pick it up.
   *
   * `useCardSearch` keeps every filter in component-local `useState` inside `SearchPage`, so
   * nothing outside that component can set one — and "View all printings" is pressed from ten
   * surfaces, nine of which are not Search. This is the channel, and it is the same shape as
   * {@link returnToDeckId}: written by one view, read and cleared once by another.
   *
   * The name travels with the id because the chip that draws the filter says the card's name,
   * and Search would otherwise have to fetch a card to caption a filter it was handed.
   */
  pendingCardSearch: { oracleId: string; name: string } | null;
```

```ts
  pendingCardSearch: null,
  // The intent and the navigation in **one** `set`, because `setActiveView` clears the open
  // deck and the open card — calling it separately would either clear the intent or race it.
  // The clears themselves are wanted: leaving the view closes the deck, as it always has.
  requestAllPrintings: (pendingCardSearch) =>
    set({
      pendingCardSearch,
      activeView: "search",
      selectedCardId: null,
      paneDeckContext: null,
      openDeckId: null,
      returnToDeckId: null,
    }),
  // Read once. A reader who clears the filter and comes back to Search must not find it
  // re-applied — the same reason `clearReturnToDeck` exists.
  consumePendingCardSearch: () => {
    const pending = get().pendingCardSearch;
    if (pending !== null) set({ pendingCardSearch: null });
    return pending;
  },
```

`create<AppState>((set) => …)` becomes `create<AppState>((set, get) => …)`.

- [ ] **Step 5: Implement the `useCardSearch` half**

Add `const [oracleId, setOracleId] = useState("")` and `oracleName`, put `oracleId` in the query
key **as its own segment** and in the request payload, include it in `activeFilterCount` and
clear it in `resetAll`.

Consume the intent with the adjust-state-during-render pattern the file already uses for
`appliedDefaultFormat` — **not** a `useEffect`. An effect runs after the paint, so the panel
would draw one frame of the previous filters and fire a whole request for them, which against a
116k-row corpus is a visible wall of the wrong cards. Copy the comment's reasoning from the
`appliedDefaultFormat` block above it.

```ts
  // Consumed during render, not in an effect: an effect fires the unfiltered request first and
  // answers it, which is a wall of the wrong cards and a second round trip to replace it. Same
  // pattern, and the same reason, as `appliedDefaultFormat` above.
  const pending = useAppStore.getState().pendingCardSearch;
  if (pending !== null) {
    useAppStore.getState().consumePendingCardSearch();
    setOracleId(pending.oracleId);
    setOracleName(pending.name);
    setText(""); setFormat(""); setColors([]); setSets([]); setManaValues([]);
    setManaX(false); setOwned(undefined);
    setAllPrintings(true);
    setUnplayable(true);
  }
```

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run src/lib/store.test.ts src/features/search/useCardSearch.test.ts`
Expected: PASS.

- [ ] **Step 7: Draw the filter**

`FilterBar` (or `FilterChips`) needs a removable chip for the card filter when `oracleId` is
set, captioned with `oracleName` and clearing `oracleId` on press — otherwise the reader has a
wall narrowed to one card with nothing on screen saying why. Follow whatever the neighbouring
chips do; do not invent a new shape.

- [ ] **Step 8: Commit**

```bash
git add src/lib/store.ts src/lib/store.test.ts src/features/search
git commit -m "feat(search): view all printings of one card

useCardSearch keeps its filters in component-local state, so a channel
was needed: pendingCardSearch, written by the menu and consumed once by
Search -- the same shape as returnToDeckId. Consumed during render and
not in an effect, or the unfiltered request fires first and answers with
a wall of the wrong cards.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `cardMenu.tsx`

**Depends on:** Tasks 4, 5, 6, 9.

**Files:**
- Create: `src/features/card/cardMenu.tsx`
- Test: `src/features/card/cardMenu.test.tsx`

**Interfaces:**
- Consumes: `MenuItem` from `@/components/menu/types`; `copyText`; `scryfallCardUrl`, `marketplaceSearchUrl`, `openExternal`; `ipc.cardImageUri`; `useMarketplace`; `useAppStore`.
- Produces:

```tsx
export interface CardMenuTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  oracleId: string | null;
  /** The printing's finish list as stored JSON. Parse with `parseFinishes` from `@/lib/finish`. */
  finishes: string | null;
  /** Only where the surface names one — a collection row, a wishlist row with a preference. */
  finish?: Finish;
}

/** Everything the card menu needs that is not the card. Built once per surface, not per row. */
export interface CardMenuDeps {
  marketplace: Marketplace;
  addToCollection: (target: CardMenuTarget, finish: Finish) => void;
  addToWishlist: (target: CardMenuTarget) => void;
  /** Null outside the deck editor: inside it, the item opens the card pane instead. */
  viewPrintingsInPane: ((cardId: string) => void) | null;
  requestAllPrintings: (t: { oracleId: string; name: string }) => void;
  DeckTargetSubmenu: ComponentType<{ target: CardMenuTarget; onDone: () => void }>;
}

export function buildCardMenu(target: CardMenuTarget, deps: CardMenuDeps): MenuItem[];
```

**Context you need:**

- **The printings list is the one adapter that reads two objects.** A `Printing` row carries
  `setCode`, `collectorNumber` and `finishes` but **no `name` and no `oracleId`** — it is a
  printing of the card the pane is open on, so both come from that `CardDetail`. Getting this
  wrong is invisible: the menu still draws, and "Copy card name" copies `undefined`.
- **`finishes` is JSON and `null` means unknown, not nonfoil.** Parse it with `parseFinishes`
  from `@/lib/finish`.
- "View all printings" needs an `oracleId`, and `CardSummary.oracleId` is nullable — a fence
  around the type rather than a card you can find (0 of 116,590 live rows are null). Disable
  the item when it is null rather than crashing.

- [ ] **Step 1: Write the failing tests**

```tsx
const BOLT: CardMenuTarget = {
  cardId: "bolt-lea", name: "Lightning Bolt", setCode: "lea", collectorNumber: "161",
  oracleId: "o-bolt", finishes: '["nonfoil"]',
};

function labels(items: MenuItem[]): string[] {
  return items.filter((i) => i.kind !== "separator").map((i) => i.label);
}
function find(items: MenuItem[], label: string) {
  const hit = items.find((i) => i.kind !== "separator" && i.label === label);
  if (!hit) throw new Error(`no item ${label} in ${labels(items).join(", ")}`);
  return hit;
}

describe("buildCardMenu", () => {
  it("copies the printed name", async () => {
    const items = buildCardMenu(BOLT, deps());
    (find(items, "Copy card name") as MenuAction).onSelect();
    await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith("Lightning Bolt"));
  });

  it("asks for the display variant's URL only when the item is pressed", async () => {
    const items = buildCardMenu(BOLT, deps());
    // The whole rule: a menu that merely offers the URL must not have fetched it.
    expect(vi.mocked(ipc.cardImageUri)).not.toHaveBeenCalled();

    vi.mocked(ipc.cardImageUri).mockResolvedValue("https://cards.scryfall.io/display/x.webp?1");
    (find(items, "Copy card image") as MenuAction).onSelect();

    await waitFor(() => expect(vi.mocked(ipc.cardImageUri))
      .toHaveBeenCalledWith("bolt-lea", "display"));
    await waitFor(() => expect(vi.mocked(copyText))
      .toHaveBeenCalledWith("https://cards.scryfall.io/display/x.webp?1"));
  });

  it("copies nothing when the card has no stored image", async () => {
    vi.mocked(ipc.cardImageUri).mockResolvedValue(null);
    const items = buildCardMenu(BOLT, deps());
    (find(items, "Copy card image") as MenuAction).onSelect();
    await waitFor(() => expect(vi.mocked(ipc.cardImageUri)).toHaveBeenCalled());
    expect(vi.mocked(copyText)).not.toHaveBeenCalled();
  });

  it("offers Scryfall and exactly one marketplace, named for the setting", () => {
    const items = buildCardMenu(BOLT, deps({ marketplace: MARKETPLACES.cardkingdom }));
    const openOn = find(items, "Open on") as MenuSubmenu;
    expect(labels(openOn.items)).toEqual(["Scryfall", "Card Kingdom"]);
  });

  it("opens nothing until the entry is pressed", async () => {
    const items = buildCardMenu(BOLT, deps({ marketplace: MARKETPLACES.cardmarket }));
    const openOn = find(items, "Open on") as MenuSubmenu;
    expect(vi.mocked(openExternal)).not.toHaveBeenCalled();

    (openOn.items[0] as MenuAction).onSelect();
    await waitFor(() => expect(vi.mocked(openExternal))
      .toHaveBeenCalledWith("https://scryfall.com/card/lea/161"));
  });

  it("routes View all printings to Search outside the editor", () => {
    const requestAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ requestAllPrintings, viewPrintingsInPane: null }));
    (find(items, "View all printings") as MenuAction).onSelect();
    expect(requestAllPrintings).toHaveBeenCalledWith({ oracleId: "o-bolt", name: "Lightning Bolt" });
  });

  it("routes View all printings to the card pane inside the editor", () => {
    const viewPrintingsInPane = vi.fn();
    const requestAllPrintings = vi.fn();
    const items = buildCardMenu(BOLT, deps({ viewPrintingsInPane, requestAllPrintings }));
    (find(items, "View all printings") as MenuAction).onSelect();
    // Navigating would close the deck -- setActiveView clears openDeckId by design.
    expect(viewPrintingsInPane).toHaveBeenCalledWith("bolt-lea");
    expect(requestAllPrintings).not.toHaveBeenCalled();
  });

  it("disables View all printings for an orphan with no oracle id", () => {
    const items = buildCardMenu({ ...BOLT, oracleId: null }, deps());
    const item = find(items, "View all printings") as MenuAction;
    expect(item.disabled).toBe(true);
    expect(item.reason).toBeTruthy();
  });

  it("adds one copy silently when the printing has one finish", () => {
    const addToCollection = vi.fn();
    const items = buildCardMenu(BOLT, deps({ addToCollection }));
    const addTo = find(items, "Add to") as MenuSubmenu;
    const collection = find(addTo.items, "Collection");
    expect(collection.kind).toBe("action");
    (collection as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(BOLT, "nonfoil");
  });

  it("offers a finish submenu when the printing has more than one and the surface named none", () => {
    const target = { ...BOLT, finishes: '["nonfoil","foil"]' };
    const addTo = find(buildCardMenu(target, deps()), "Add to") as MenuSubmenu;
    const collection = find(addTo.items, "Collection") as MenuSubmenu;
    expect(collection.kind).toBe("submenu");
    expect(labels(collection.items)).toEqual(["Nonfoil", "Foil"]);
  });

  it("uses the surface's own finish without asking", () => {
    const addToCollection = vi.fn();
    const target: CardMenuTarget = { ...BOLT, finishes: '["nonfoil","foil"]', finish: "foil" };
    const addTo = find(buildCardMenu(target, deps({ addToCollection })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Collection") as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "foil");
  });

  it("treats a null finishes column as nonfoil rather than as no finishes at all", () => {
    // `null` means the column is empty -- unknown, not "this printing has no finishes".
    const addToCollection = vi.fn();
    const target = { ...BOLT, finishes: null };
    const addTo = find(buildCardMenu(target, deps({ addToCollection })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Collection") as MenuAction).onSelect();
    expect(addToCollection).toHaveBeenCalledWith(target, "nonfoil");
  });

  it("wishes for the exact printing", () => {
    const addToWishlist = vi.fn();
    const addTo = find(buildCardMenu(BOLT, deps({ addToWishlist })), "Add to") as MenuSubmenu;
    (find(addTo.items, "Wishlist") as MenuAction).onSelect();
    expect(addToWishlist).toHaveBeenCalledWith(BOLT);
  });

  it("puts the deck picker behind a lazy row", () => {
    const addTo = find(buildCardMenu(BOLT, deps()), "Add to") as MenuSubmenu;
    const deck = find(addTo.items, "Deck");
    // Lazy, so the folder tree and the deck list are fetched on expand and never on open.
    expect(deck.kind).toBe("lazy");
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/card/cardMenu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement `buildCardMenu`**

Straight from the tests. Notes that belong at the code:

```tsx
/**
 * What a card offers on a right-click, anywhere it is drawn.
 *
 * **A pure builder, and its dependencies are an argument.** Ten surfaces call it — the two
 * search views, the two collection views, the wishlist, four deck editor views, the docked
 * panel, the card pane and the printings list — and each has its own writes, its own
 * marketplace hook instance and its own answer to "am I inside the deck editor". Passing
 * `CardMenuDeps` keeps every one of those decisions at the surface and keeps this file
 * testable without a provider.
 *
 * **Nothing here reaches the backend while the menu is merely open.** "Copy card image" asks
 * `card_image_uri` in its `onSelect`; "Open on" builds a string and calls `openExternal` in
 * its; the deck picker is a `lazy` row whose component mounts on expand. That is a rule, not
 * an optimisation — a menu that fetched on open would fire a request every time a reader
 * right-clicked the wrong tile.
 */
```

The finish rule:

```tsx
/**
 * Which finish an "Add to collection" records, and whether the reader is asked.
 *
 * A collection row's identity includes its finish, so one has to be chosen. The surface's own
 * wins where it has one (a collection row *is* a finish; a wishlist row may prefer one).
 * Where it has none — a search tile, a deck card, a printings row, because **a deck names a
 * printing and not a finish** — the printing's own list decides: one finish is no question and
 * adds silently, two or more is a submenu.
 *
 * `finishes` is `null` when the column is empty, which is **unknown** rather than "no
 * finishes". Nonfoil is the answer there, because it is the answer for all but a handful of
 * printings and because refusing to add a card over a missing column would be worse.
 */
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/features/card/cardMenu.test.tsx`
Expected: PASS, all fourteen.

- [ ] **Step 5: Write `DeckTargetSubmenu`**

In the same file or beside it. A `lazy` `Content` component that calls `useDecks()` and
`useDeckFolders()`, builds the tree with `buildFolderTree` from `../decks/FolderTree`, and
renders **nested** `MenuSubmenu`s: folder → subfolder → deck → `Live` / `Theory`. Decks and
folders in each level go through `sortOptions`; the leaf pair is `Live` then `Theory` in that
order, which is not alphabetical and is not meant to be — comment it.

Selecting a leaf calls `useDeck(deckId, variant).addCard` with **no category**, so
`autoCategoryFor` files the card by what it does — the app's one rule, and the one a plain add,
a drag with no column under it and an imported line all share.

- [ ] **Step 6: Commit**

```bash
git add src/features/card/cardMenu.tsx src/features/card/cardMenu.test.tsx
git commit -m "feat(card): the card context menu

A pure builder whose dependencies are an argument, because ten surfaces
call it and each owns its own writes. Nothing reaches the backend while
the menu is merely open: the image URL is fetched in onSelect, the deck
picker is a lazy row that mounts on expand.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 11: `deckMenu.tsx` and `folderMenu.tsx`

**Depends on:** Tasks 4, 5.

**Files:**
- Create: `src/features/decks/deckMenu.tsx`, `src/features/decks/folderMenu.tsx`
- Modify: `src/features/decks/DecksPage.tsx` (host `DeckSettingsDialog`, add an inline rename field)
- Test: `src/features/decks/deckMenu.test.tsx`

**Interfaces:**
- Consumes: `MenuItem`; `useDecks`, `useDeckFolders`; `buildFolderTree`, `flattenFolders`, `folderDescendants` from `./FolderTree`; `DeckSettingsDialog`.
- Produces:

```tsx
export function buildDeckMenu(deck: DeckRow, deps: DeckMenuDeps): MenuItem[];
export function buildFolderMenu(folder: DeckFolder, deps: FolderMenuDeps): MenuItem[];
```

**Context you need:**

- **Deck rename has no inline affordance today.** Renaming currently means opening the editor
  and typing into its settings dialog. Model the new field on `metaRows.tsx`'s `RenameField`,
  which the folder rename already uses — do not write a third rename control.
- **`DeckSettingsDialog` gets a second host.** `DeckSettingsForm` owns no mutation and imports
  no backend hook by design, and is drawn by two hosts today, so a third is the shape it was
  built for. `DeckSettingsDialog.test.tsx` and `DeckSettingsForm.test.tsx` should need no
  edits; if they do, you have changed the form rather than added a host.
- **Delete keeps its confirmation.** `DecksPage` already has `askDelete` / `confirmDelete` —
  route the menu item into those rather than calling `decks.remove` directly. A menu that opens
  by accident must not be one press from an irreversible write.
- **A folder may not be moved into itself or its descendants.** `folderDescendants` already
  computes that set; `MoveToFolder` already draws them inert with a reason.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("buildDeckMenu", () => {
  it("offers open, rename, move, settings, duplicate and delete", () => {
    expect(labels(buildDeckMenu(ATRAXA, deps()))).toEqual([
      "Open deck", "Rename…", "Move to", "Deck settings…", "Duplicate", "Delete…",
    ]);
  });

  it("opens the deck", () => {
    const setOpenDeckId = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ setOpenDeckId })), "Open deck") as MenuAction).onSelect();
    expect(setOpenDeckId).toHaveBeenCalledWith(ATRAXA.id);
  });

  it("routes delete through the confirmation the tile already uses", () => {
    const askDelete = vi.fn();
    const remove = vi.fn();
    (find(buildDeckMenu(ATRAXA, deps({ askDelete, remove })), "Delete…") as MenuAction).onSelect();
    // A menu opens by accident. It must not be one press from an irreversible write.
    expect(askDelete).toHaveBeenCalledWith(ATRAXA);
    expect(remove).not.toHaveBeenCalled();
  });

  it("marks the folder the deck is already in as where it is now", () => {
    const moveTo = find(buildDeckMenu({ ...ATRAXA, folderId: 3 }, deps()), "Move to") as MenuLazy;
    expect(moveTo.kind).toBe("lazy");   // the folder tree is fetched on expand
  });
});

describe("buildFolderMenu", () => {
  it("offers the five things the tree's buttons already do", () => {
    expect(labels(buildFolderMenu(COMMANDER, folderDeps()))).toEqual([
      "New deck here", "New subfolder…", "Rename…", "Move to", "Delete…",
    ]);
  });

  it("cannot move a folder into itself or its own descendants", () => {
    const forbidden = forbiddenFor(buildFolderMenu(COMMANDER, folderDeps()));
    expect(forbidden).toContain(COMMANDER.id);
    expect(forbidden).toContain(BUDGET.id);   // a child of Commander
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/deckMenu.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement both builders**

- [ ] **Step 4: Host `DeckSettingsDialog` on `DecksPage`**

One piece of state (`settingsDeckId: number | null`), the dialog mounted unconditionally with
`open={settingsDeckId !== null}` — `DeckDialog` mounts nothing while closed, which is what makes
that free. `onDismiss` must be a `useCallback`.

- [ ] **Step 5: Add the inline rename field to the tile**

Reuse `metaRows.tsx`'s `RenameField`. Follow `DecksPage`'s existing `renameFolder` panel state
shape — it already has one, and a second mechanism for the same gesture would be two.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run src/features/decks/deckMenu.test.tsx src/features/decks/DecksPage.test.tsx src/features/decks/DeckSettingsDialog.test.tsx`
Expected: PASS, **with no edit to `DeckSettingsDialog.test.tsx` or `DeckSettingsForm.test.tsx`**.

- [ ] **Step 7: Commit**

```bash
git add src/features/decks/deckMenu.tsx src/features/decks/folderMenu.tsx src/features/decks/DecksPage.tsx src/features/decks/deckMenu.test.tsx
git commit -m "feat(decks): the deck and folder context menus

Rename is a new inline field on the tile, built on metaRows' RenameField
rather than a third rename control. DeckSettingsDialog gets a second
host, which is the shape DeckSettingsForm was built for -- it owns no
mutation and imports no backend hook. Delete routes through the
confirmation the tile already uses.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: `categoryMenu.tsx`

**Depends on:** Tasks 4, 5, 7, 8.

**Files:**
- Create: `src/features/decks/categoryMenu.tsx`
- Modify: `src/features/decks/import/ImportDeckDialog.tsx`, `src/features/decks/import/useDeckImport.ts`, `src/features/decks/import/plan.ts` (the optional forced category)
- Test: `src/features/decks/categoryMenu.test.tsx`, `src/features/decks/import/plan.test.ts`

**Interfaces:**
- Consumes: `MenuItem`; `useDeckMeta`; `ExportDialog`; `ImportDeckDialog`.
- Produces:

```tsx
export function buildCategoryMenu(category: DeckCategory, deps: CategoryMenuDeps): MenuItem[];
// and, on the import path:
// buildImportPlan(..., forcedCategoryName?: string) — absent keeps today's behaviour exactly.
```

**Context you need:**

- **Delete is refused for the four predefined zones** (Commander, Sideboard, Companion,
  Maybeboard) by the backend. So both destructive entries are **absent** on those rather than
  greyed — an item that exists only to be refused is worse than one that is not there.
- **`is_active = 0` is the whole of what `maybe` used to mean.** An inactive category counts
  toward nothing: not size, not copy limits, not legality, and the allocator claims no copy for
  it. `set_category_active` is the write, and it re-runs the allocator.
- **The forced category is an optional argument that defaults to today's behaviour.** The
  toolbar's Import passes nothing and must behave exactly as it does now — `plan.ts` is pure
  and its existing tests must pass unedited.
- **`plan.ts` makes every deck decision and the dialog makes none.** Put the override in the
  planner, not in the dialog.

- [ ] **Step 1: Write the failing tests**

```tsx
describe("buildCategoryMenu", () => {
  it("offers rename, import, export, the switch and delete for a category the reader made", () => {
    expect(labels(buildCategoryMenu(REMOVAL, deps()))).toEqual([
      "Rename…", "Import cards…", "Export cards…", "Deactivate", "Delete…",
    ]);
  });

  it("says Activate for a switched-off pile", () => {
    expect(labels(buildCategoryMenu({ ...REMOVAL, isActive: false }, deps())))
      .toContain("Activate");
  });

  it("leaves the switch and delete off the four predefined zones", () => {
    // The backend refuses to delete these. An item that exists only to be refused is worse
    // than one that is not there.
    const items = labels(buildCategoryMenu(COMMANDER_ZONE, deps()));
    expect(items).not.toContain("Delete…");
    expect(items).toEqual(["Rename…", "Import cards…", "Export cards…"]);
  });

  it("hands the category's own cards to the export dialog", () => {
    const openExport = vi.fn();
    (find(buildCategoryMenu(REMOVAL, deps({ openExport })), "Export cards…") as MenuAction)
      .onSelect();
    expect(openExport).toHaveBeenCalledWith(
      expect.objectContaining({ subject: "Removal", cards: REMOVAL_CARDS }),
    );
  });

  it("opens the importer aimed at this pile", () => {
    const openImport = vi.fn();
    (find(buildCategoryMenu(REMOVAL, deps({ openImport })), "Import cards…") as MenuAction)
      .onSelect();
    expect(openImport).toHaveBeenCalledWith({ forcedCategoryName: "Removal" });
  });
});

describe("buildImportPlan with a forced category", () => {
  it("files every line into the named pile", () => {
    const plan = buildImportPlan(LINES, PRINTINGS, TAGS, "Removal");
    expect(new Set(plan.items.map((i) => i.categoryName))).toEqual(new Set(["Removal"]));
  });

  it("files by what the card does when no category is forced", () => {
    // The toolbar's Import passes nothing, and must behave exactly as it does today.
    const plan = buildImportPlan(LINES, PRINTINGS, TAGS);
    expect(new Set(plan.items.map((i) => i.categoryName)).size).toBeGreaterThan(1);
  });
});
```

Read `plan.ts` and fix the function name, argument order and result shape to match it.

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run src/features/decks/categoryMenu.test.tsx src/features/decks/import/plan.test.ts`
Expected: the new tests FAIL, every existing `plan.test.ts` test PASSES.

- [ ] **Step 3: Implement the builder and the forced-category argument**

The override goes in `plan.ts` as a trailing optional parameter, applied where
`autoCategoryFor` is called. Comment it:

```ts
  // **A named pile overrides the filer, which is the rule this app already has**: an add that
  // names a category is untouched, and only an add that names none is filed by what the card
  // does. Right-clicking "Removal" and pressing Import names one. Absent, and every existing
  // caller is byte-for-byte unchanged.
```

- [ ] **Step 4: Wire the dialogs into `DeckEditor`**

`DeckEditor`'s `Layer` union gains `{ kind: "export"; categoryId: number }`, and its `import`
arm gains an optional `forcedCategoryName`. **One union and not six booleans** — that is why
the union exists, and `useDismissOnEscape` orders exactly two rungs, so at most one of these is
ever mounted.

- [ ] **Step 5: Run to verify they pass**

Run: `npx vitest run src/features/decks`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/features/decks
git commit -m "feat(decks): the category context menu, and an import aimed at one pile

The forced category is a trailing optional argument on the planner --
plan.ts makes every deck decision and the dialog makes none -- so the
toolbar's Import is byte-for-byte unchanged. Delete and the switch are
absent on the four predefined zones rather than greyed: the backend
refuses them, and an item that exists only to be refused is worse than
one that is not there.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Wire the search, collection and wishlist surfaces

**Depends on:** Task 10.

**Files:**
- Modify: `src/features/search/CardGrid.tsx`, `src/features/search/SearchPage.tsx`, `src/features/collection/CollectionTable.tsx`, `src/features/collection/CollectionPage.tsx`, `src/features/wishlist/WishlistPage.tsx`
- Test: add cases to each surface's existing test file

**Interfaces:**
- Consumes: `useContextMenu`, `buildCardMenu`, `CardMenuTarget`.
- Produces: nothing new.

**Context you need:** `CardGrid` is shared by the search wall, the collection wall and the
docked deck-search panel, so **one `onContextMenu` there serves three surfaces** — take the
menu builder as a prop rather than reaching for a hook inside it. The collection table's rows
carry a `finish`; the wishlist's carry `preferredFinish`, which may be `null`.

Every table row already opens the card on click and on Enter/Space, and a control inside a row
stops those two keys with `stopRowActivationKeys` — a right-click must not also open the card.

- [ ] **Step 1: Write the failing tests** — one per surface, all the same shape:

```tsx
it("opens the card menu on right-click without opening the card", async () => {
  render(<CollectionPage />, { wrapper });
  const row = await screen.findByRole("row", { name: /Lightning Bolt/ });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

  expect(await screen.findByRole("menu")).toBeInTheDocument();
  // The pane belongs to a left click. A right-click asks a question about the row.
  expect(screen.queryByRole("complementary", { name: /card detail/i })).not.toBeInTheDocument();
});

it("passes the row's own finish, so a foil row adds a foil", async () => {
  render(<CollectionPage />, { wrapper });
  const row = await screen.findByRole("row", { name: /Lightning Bolt.*Foil/ });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await screen.findByRole("menu");

  // No finish submenu: the surface named one.
  const addTo = screen.getByRole("menuitem", { name: /Add to/ });
  await userEvent.setup().hover(addTo);
  expect(await screen.findByRole("menuitem", { name: "Collection" }))
    .not.toHaveAttribute("aria-haspopup", "menu");
});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Wire each surface** — one adapter per surface, building a `CardMenuTarget` from
      the row it holds, and one `CardMenuDeps` per page (not per row).
- [ ] **Step 4: Run the three suites to verify they pass**

Run: `npx vitest run src/features/search src/features/collection src/features/wishlist`

- [ ] **Step 5: Commit** — `feat(search,collection,wishlist): right-click a card`

---

### Task 14: Wire the deck editor's four views and the docked panel

**Depends on:** Task 10.

**Files:**
- Modify: `src/features/decks/views/StackView.tsx`, `GridView.tsx`, `TableView.tsx`, `TextView.tsx`, `src/features/decks/CardStack.tsx`, `src/features/decks/cardControl.tsx`, `src/features/decks/DeckSearchPanel.tsx`, `src/features/decks/DeckEditor.tsx`
- Test: `src/features/decks/views.test.tsx`, `src/features/decks/DeckEditor.test.tsx`

**Context you need:**

- The deck-card menu is `buildCardMenu` **plus** the deck extras, so build it in `DeckEditor`
  once and hand the four views one function. A view that assembled its own would be four copies
  of one rule.
- **`Move to` is built from `DeckEditor`'s `categories` array — every category the deck has, in
  `sortOrder` — never from the drawn groups.** That array is deliberately *not* filtered by
  anything, and for an emptied auto pile it is the only surface the pile appears on at all.
  This is what makes the menu reach a pile with no heading, which is the one thing the removed
  `Move…` select could do that a drag cannot.
- **Categories are one of exactly two exemptions from `sortOptions`** — an order the reader
  arranged themselves. Put the comment at the site, as the other exemption does.
  > **Stale as of 2026-08-15, annotated rather than rewritten.** "Exactly two" was true when this
  > plan was written; executing it added several more. The instruction is still right — put the
  > comment at the site — but the count is not. `src/CLAUDE.md` carries the test the exemptions
  > are granted by and deliberately keeps no list.
- `commanderIneligibility` (`validation/commanders.ts`) and the companion rule
  (`validation/companions.ts`) supply the greyed items' reasons. Do not write a looser test
  here: it would offer a card the validation panel then refuses.
- A deck card wears **at most one** tag, so the tag rows are `kind: "radio"` with "None" first.

- [ ] **Step 1: Write the failing tests**

```tsx
it("lists every category of the deck, including one with no heading on screen", async () => {
  // An emptied auto pile draws no heading, so a drag cannot reach it. This menu can, and
  // that is the whole reason it replaces the Move… select removed on 2026-08-14.
  render(<DeckEditor deckId={1} />, { wrapper });
  await rightClickCard("Lightning Bolt");
  await userEvent.setup().hover(screen.getByRole("menuitem", { name: /Move to/ }));
  expect(await screen.findByRole("menuitem", { name: "Recursion" })).toBeInTheDocument();
});

it("keeps the reader's own category order rather than sorting it", async () => {
  render(<DeckEditor deckId={1} />, { wrapper });
  await rightClickCard("Lightning Bolt");
  await userEvent.setup().hover(screen.getByRole("menuitem", { name: /Move to/ }));
  const rows = await screen.findAllByRole("menuitem");
  expect(rows.map((r) => r.textContent)).toEqual(DECK_CATEGORIES_IN_SORT_ORDER);
});

it("offers no commander item in a format with no command zone", async () => {
  render(<DeckEditor deckId={MODERN_DECK} />, { wrapper });
  await rightClickCard("Lightning Bolt");
  expect(screen.queryByRole("menuitem", { name: /Set as commander/ })).not.toBeInTheDocument();
});

it("greys the commander item with its reason in Commander", async () => {
  render(<DeckEditor deckId={COMMANDER_DECK} />, { wrapper });
  await rightClickCard("Lightning Bolt");
  const item = await screen.findByRole("menuitem", { name: /Set as commander/ });
  expect(item).toHaveAttribute("aria-disabled", "true");
  expect(item).toHaveTextContent(/legendary/i);
});

it("offers the commander item live for an eligible card", async () => {
  render(<DeckEditor deckId={COMMANDER_DECK} />, { wrapper });
  await rightClickCard("Atraxa, Praetors' Voice");
  expect(await screen.findByRole("menuitem", { name: /Set as commander/ }))
    .toHaveAttribute("aria-disabled", "false");
});

it("draws the tags as a radio group with the card's own ticked", async () => {
  render(<DeckEditor deckId={1} />, { wrapper });
  await rightClickCard("Lightning Bolt");
  await userEvent.setup().hover(screen.getByRole("menuitem", { name: /Tag card/ }));
  // At most one tag per card -- setTag takes a tagId or null.
  const none = await screen.findByRole("menuitemradio", { name: "None" });
  expect(none).toHaveAttribute("aria-checked", "false");
  expect(screen.getByRole("menuitemradio", { name: /Budget swap/ }))
    .toHaveAttribute("aria-checked", "true");
});
```

- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Build the deck-card menu in `DeckEditor` and thread one function into the views**
- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/features/decks`

- [ ] **Step 5: Commit** — `feat(decks): right-click a card in the deck editor`

---

### Task 15: Wire the card pane, the printings list, the deck tile, the folder row and the category heading

**Depends on:** Tasks 10, 11, 12.

**Files:**
- Modify: `src/features/card/CardDetailPane.tsx`, `src/features/card/PrintingPreview.tsx`, `src/features/decks/DecksPage.tsx`, `src/features/decks/FolderTree.tsx`, `src/features/decks/views/GroupHeader.tsx`
- Test: the existing test file for each

**⚠️ The printings-list adapter reads two objects.** A `Printing` row carries `setCode`,
`collectorNumber` and `finishes` but **no `name` and no `oracleId`** — it is a printing of the
card the pane is open on, so both come from that `CardDetail`. Getting this wrong is invisible:
the menu still draws, and "Copy card name" copies `undefined`. Pin it:

```tsx
it("names the card the pane is open on, not the printing row", async () => {
  render(<CardDetailPane cardId="bolt-lea" onClose={noop} />, { wrapper });
  const row = await screen.findByRole("row", { name: /Fourth Edition/ });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await screen.findByRole("menu");

  await userEvent.setup().click(screen.getByRole("menuitem", { name: "Copy card name" }));
  // A Printing carries no name. This is the one adapter that has to read the CardDetail too.
  await waitFor(() => expect(vi.mocked(copyText)).toHaveBeenCalledWith("Lightning Bolt"));
  expect(vi.mocked(copyText)).not.toHaveBeenCalledWith(undefined);
});

it("links the printing that was right-clicked, not the one the pane is showing", async () => {
  render(<CardDetailPane cardId="bolt-lea" onClose={noop} />, { wrapper });
  const row = await screen.findByRole("row", { name: /Fourth Edition/ });
  row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await screen.findByRole("menu");
  await userEvent.setup().hover(screen.getByRole("menuitem", { name: /Open on/ }));
  await userEvent.setup().click(await screen.findByRole("menuitem", { name: "Scryfall" }));

  expect(vi.mocked(openExternal)).toHaveBeenCalledWith("https://scryfall.com/card/4ed/209");
});
```

- [ ] **Step 1: Write the failing tests** (the two above, plus one open-the-menu test per surface)
- [ ] **Step 2: Run to verify they fail**
- [ ] **Step 3: Wire the five surfaces**, adding `menuKey` beside `menu` on the deck tile, the
      folder row and the category heading so Shift+F10 reaches them
- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run src/features/card src/features/decks`

- [ ] **Step 5: Commit** — `feat(ui): right-click the card pane, printings, tiles, folders and headings`

---

### Task 16: The Storybook fake and the stories

**Controller task, after fan-in.**

**Files:**
- Modify: `.storybook/fake/db.ts` — **open it with Read, never Grep.** ripgrep classifies it as binary, so "no matches" there is a lie.
- Create: `src/components/menu/ContextMenu.stories.tsx`, `src/features/decks/export/ExportDialog.stories.tsx`

- [ ] **Step 1: Teach the fake the three new commands**

`card_image_uri`, `export_write_file`, and `search_cards`' `oracleId` filter. Follow the fake's
existing shape exactly; add a **fault** for each where the fake has faults, so a story can show
the refusal path (a card with no stored image, a write that is denied).

- [ ] **Step 2: Write the stories**

Use `mcp__mtg-grimoire-sb-mcp` first: `get-storybook-story-instructions` for the current
conventions, and `get-documentation` before using **any** property on a design-system
component. Never assume a property from its name.

Cover: the card menu open, a submenu expanded, a greyed commander item with its reason, the tag
radio group, the deck menu, the category menu, and the export dialog per format.

- [ ] **Step 3: Write the `play` functions but do not run them** — `stories.test.tsx` collects
      the whole tree, so plays are the controller's fix round, after everything else is green.

- [ ] **Step 4: Commit** — `test(storybook): the context menus and the export dialog`

---

### Task 17: Documentation

**Controller task.**

- [ ] **Step 1: `src/CLAUDE.md`** — a binding rule for the menu: one instance at the root and
      why; hand-positioned against `documentElement.clientWidth`; the native menu survives only
      in text fields.
- [ ] **Step 2: `src/features/decks/CLAUDE.md`** — the `Move…` select's replacement (its
      current entry says there is no keyboard path to moving a card, and that stops being true);
      the import's forced category; the export module.
- [ ] **Step 3: `src-tauri/CLAUDE.md`** — the two new permissions and, in the Tauri
      capabilities section, **why `dialog:allow-save` needed a Rust writer**: that section
      currently says the app grants no `fs:` permission, and this is the second command that
      keeps it true.
- [ ] **Step 4: `docs/reference/frontend-design.md`** — the live measurements from Task 18.
- [ ] **Step 5: Re-count anything you changed.** A prose-only edit routes to neither CI job, so
      nothing goes red when a document rots. Better still: do not write down a number a build
      already answers.
- [ ] **Step 6: Commit** — `docs: the context menu rules`

---

### Task 18: Verify, then drive the real window

**Controller task. Nothing here is optional — every UI task in this repo's plans has found
something the suite could not.**

- [ ] **Step 1: `npm install`** (the clipboard plugin landed in Task 3; without this, `tsc`
      fails TS2307 on its import and it reads as a real failure)

- [ ] **Step 2: `npm run verify`, redirected to a file**

```powershell
npm run verify *> verify.log
Select-String -Path verify.log -Pattern "Test Files|Tests|error|warning" | Select-Object -Last 40
```

**Never pipe it to `tail`** — the exit code is tail's 0 while tests fail. **Never run two at
once** — concurrent runs fake ~18 Rust schema failures.

- [ ] **Step 3: `cargo fmt`** — `npm run verify` does not run it, and CI's Linux rust job does.

```powershell
cd src-tauri; cargo fmt --check; cd ..
```

- [ ] **Step 4: Run the story plays** — the fix round the fan-out could not do.

- [ ] **Step 5: Take the app lock and launch**

Follow the `running-the-app` skill. Only one app runs across every worktree and the collision
is silent — a second one exits with code 0, no window and no stderr.

- [ ] **Step 6: Drive it over CDP** — `docs/reference/live-ui-verification.md` is the contract.
      Use **PowerShell**, not Bash: the Bash tool refuses `cdp.mjs` eval in a worktree as
      unverifiable. Avoid nested quotes and `$`.

Six things, each of which only a live pass can answer:

1. **Nothing clips the menu.** Right-click a card in the last row of the search wall, in the
   deck editor's rail, and inside a virtualised collection row. The panel must be fully visible
   in all three — the row is `position: absolute` and transformed, and a menu mounted there
   would be capped at that row's `LAYER.raised`.
2. **The flip is right at both edges**, at 1280×800 with a page scrollbar and without one.
   Read `document.documentElement.clientWidth` and `window.innerWidth` in the same eval and
   **record both numbers** — they differ by the scrollbar, and the difference is the whole
   reason the rule exists.
3. **Escape closes exactly one layer per press** through the deepest stack the app can build:
   submenu → menu → deck dialog → card pane. Four presses, four closes, in that order.
4. **No horizontal scrollbar on the deck editor at 1024, 1280 and 1920** with a four-level
   cascade open near the right edge. This is the one thing the 1024px floor forbids and a
   cascade is a new way to reach it. Compare `scrollWidth` against `clientWidth`.
5. **The clipboard actually receives text**, and **`openUrl` actually opens** — a plugin call
   that is denied by the ACL fails at runtime and in the shipped window only.
6. **Reduced motion.** Under emulated `prefers-reduced-motion: reduce`, the menu's `transform`
   must be `none` while `opacity` still animates — `MotionConfig reducedMotion="user"` reduces
   the scale because it is a transform, and the opacity rule is the weaker one `motion.ts`
   documents on purpose. Beware the false failure the harness contract warns about:
   `transition-property: none` while `transition-duration` still reads `0.12s`.

- [ ] **Step 7: Record every measurement** in `docs/reference/frontend-design.md`, with the
      date and the build (debug or release) — the same measurement can differ by ~8×.

- [ ] **Step 8: Release the app lock and delete the copied database**

```powershell
pwsh -NoProfile -File .claude\skills\running-the-app\lock.ps1 release app
Get-Process mtg-grimoire -ErrorAction SilentlyContinue    # must be empty
Remove-Item "src-tauri\target\debug\data" -Recurse -Force
```

- [ ] **Step 9: Ship** — the `auto-pr` skill. `npm run verify` → PR → merge `main` in (never
      rebase) → arm auto-merge → watch for the only two states GitHub abandons, a real conflict
      and a red `ci-ok`. **The agent does not press Merge.** Budget for 3+ merges of `main` per
      PR; do not chase `BEHIND`.

---

## Self-Review

**Spec coverage.** Every section maps to a task: §1 the primitive → 4, 5; §2 native menu policy
→ 5; §3 the card menu → 10, 13, 15; §4 deck-card extras → 14; §5 deck menu → 11; §5b folder menu
→ 11; §6 category menu → 12; §7 backend → 1, 2, 3; §8 export → 7, 8; §9 search intent → 9; §10
files → the File Structure table; §11 testing → each task's tests plus 16 and 18; §12 risks →
each risk is pinned by a named test or a named live check.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N". Tasks 13, 14
and 15 give test code and name every file rather than showing each surface's adapter, because
the adapters are one line apiece against ten different row types — the test in each is the
requirement and the row shape is that file's.

**Type consistency.** `CardMenuTarget` is defined once (Task 10) and consumed by 13, 14, 15.
`MenuItem` is defined once (Task 4) and consumed by 5, 10, 11, 12. `ExportCard` is defined once
(Task 7) and consumed by 8 and 12. `formatExport`, `copyText`, `scryfallCardUrl`,
`marketplaceSearchUrl`, `openExternal`, `cardImageUri`, `exportWriteFile`, `oracleId`,
`pendingCardSearch`, `requestAllPrintings` and `consumePendingCardSearch` are each spelled the
same way in every task that names them.
