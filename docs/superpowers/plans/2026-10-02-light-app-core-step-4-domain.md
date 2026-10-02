# The shared core, step 4: the domain cluster — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the decks, the collection, the wishlist, the search, the card pane and the view-state modules are `crates/grimoire-core`'s, with `with_write` and `schema::prepare_database` beside them — moved by one re-runnable script, with the desktop app unchanged.

**Architecture:** `scripts/core-step-4.mjs` splits each domain file at its item boundaries. Everything that has no reason to know about a window goes to `crates/grimoire-core/src/<module>.rs` with its tests; the `#[tauri::command]` wrappers, and anything else that names the desktop, stay at the module's own path as `src-tauri/src/<module>/mod.rs`, which opens with `pub use grimoire_core::<module>::*;`. So `crate::deck::…` resolves in `src-tauri` exactly as it did, and `generate_handler!` is not edited. `sync::with_write` and its body become `grimoire_core::state::with_write` over `&State`.

**Tech Stack:** Rust (the workspace's pinned toolchain), rusqlite 0.40; Node 24 for the script, no dependency.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.3, §2.8, §2.9. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2, step 4. **The steps before:** [step 1](2026-10-02-light-app-core-step-1-leaves.md), [step 2](2026-10-02-light-app-core-step-2-storage.md), [step 3](2026-10-02-light-app-core-step-3-state.md) and [light-app.md](../../reference/light-app.md) §6. **The rules for a moved module:** [`crates/grimoire-core/CLAUDE.md`](../../../crates/grimoire-core/CLAUDE.md), *Moving a module here*.

Everything measured here was measured on Windows on 2026-10-02, on this branch's tree over `main` at `28258b21`.

## What was read before any code

A splitter was written first — it cuts a rustfmt-formatted file into its top-level items by tracking comments, literals and bracket depth, and reproduces all 112 files of `src-tauri/src` byte for byte when its pieces are joined — and every item was read for what it names.

**The cluster is closed, and what holds a file in `src-tauri` is almost always one block at its foot.** Of the files on this step's list, the items that name the desktop are: the `#[tauri::command]` wrappers; the `use crate::sync::{with_write, AppState}` line above them; an `unfinished(e: tauri::Error)` helper in eight files; and the inner `mod commands` four files register from. No item that would move names an item that would stay — the survey found no such reference in any of them.

| | As measured by the run |
| --- | --- |
| Modules that move | 49 |
| Their lines in the core, tests included | 105 386 |
| Their tests | 1 684, of which 32 stay |
| Command wrappers that stay, in 46 files | 183 of the crate's 257 |

**The fixpoint that decides "closed" is mutual**: `deck` names `deck_undo`, `deck_audit`, `deck_meta`, `deck_tokens`, `deck_theory`, `collection`, `collection_folders`, `collection_alloc`, `collection_source`, `wishlist`, `wishlist_folders` and `managed_wishlist`, and each of those names `deck` or one another. Eighteen of the forty-nine name none of the others — the view-state modules and a few reads; the other thirty-one are that one knot. That is round one's "no leaf modules", measured.

## Decisions taken before any code

### The wrappers stay at each module's own path — Markus, 2026-10-02

Spec §2.3 puts the desktop's wrappers in `src-tauri/src/commands/`. Read against the tree: 245 of `generate_handler!`'s 257 entries are a path through a module (`deck::deck_create`, `deck_pull::commands::deck_pull_plan`), and `collection_source::with_write_owned` — which stays, because it names the index — is called from wrappers in 14 files. Two layouts were put to Markus: a `commands/` folder, with the handler list and every cross-module call a wrapper makes rewritten; or each module's wrappers at `src-tauri/src/<module>/mod.rs` beside a glob re-export, step 2's `schema/mod.rs` shape. **He chose the second.** No handler entry, no caller and no test path is edited, and a branch that adds a command still merges. A `commands/` folder can be a rename later, with the command table.

### Nothing is hoisted — Markus, 2026-10-02

Three things on this step's list name step-5 code:

| | Names | So |
| --- | --- | --- |
| `deck::bracket_reads` | `combos::match_combos`, `combos::DeckCombo` — `combos` is a feed, and `reqwest` is in its error type | `deck` arrives without it: the function, `DeckBracketRead` and their tests stay in `src-tauri/src/deck/mod.rs` |
| `reconcile::apply` | `scryfall::Migration` | `reconcile` waits for step 5, whole |
| `tags::query`, `tags::muted` | `tags::Dataset`, `ORACLE` and `ART`, which sit in the fetch engine | `tags/` waits for step 5, whole |

The alternative — moving `Migration`, `Dataset` and `match_combos` into the core ahead of their modules — is the hoist Markus declined in step 2 for the sync client's cursor keys, and he declined it again. Nothing else in the cluster calls `reconcile` or the tag queries.

### What stays behind without a question, by rule 8

*A function that names a later step's code stays behind, alone* (`crates/grimoire-core/CLAUDE.md`):

| Stays in `src-tauri` | Because it names | Home with |
| --- | --- | --- |
| `collection_source::with_write_owned` | `index::lifecycle::invalidate_owned` | step 5 |
| `reset::clear_cache` and what only it calls | `images::Cache`, the three feeds' `any_refresh_running` | step 5 |
| `marketplace::set_marketplace_now` | `AppState.mirror` | never: the mirror is the desktop's |
| `import::read_import_file` | a path the desktop's file dialog answered | never: a host reads its own file |
| `schema::prepare_data_dir` | `split` | never |

`share/` is not on this step's list and waits whole: its publish is the relay's.

### `with_write` is a free function over `&State`

`grimoire_core::state::{with_write, with_write_waiting}` and the private `written` they share, byte for byte but for the parameter type. `src-tauri`'s `sync` re-exports the two under their old names. A caller holding an `Arc<AppState>` passes `&state` as before: `&Arc<AppState>` coerces to `&AppState` and on to `&State` through the `Deref` step 3 added. `lock_db`, `lock_db_read`, `lock_conn` and `lock_plain` stay in `sync.rs`, which is step 5's.

### `prepare_database` goes home, and `maintenance` with it

The launch's logged passes call `maintenance`, `managed_wishlist`, `deck_tokens` and `deck_meta`. All four move, so the function rejoins `bring_to_head` in the core's `schema.rs`. `maintenance::reclaim_freed_pages` sleeps between chunks with `std::thread::sleep`; it asks `platform::pause` instead, which is that call natively.

`State::new` still takes connections already at head. A host-neutral "open the data folder" is possible now and is not built here: the desktop's `prepare_data_dir` runs `split` first, and what a second host needs from that function is phase 4's to say.

### Test scaffolding

- A test that names something that stays, stays — in the remainder's own `mod tests`. A helper both sides call becomes a fixture: a `pub mod fixtures` at the foot of the core file, behind `any(test, feature = "testing")`, which the staying tests import. A helper only the staying tests call goes with them. Nothing is copied.
- `bulk_undo::with_store` switches on `#[cfg(test)]` between a process-wide store and a thread-local one. A dependency's `cfg(test)` is off while `src-tauri`'s tests build, so it follows `any(test, feature = "testing")` (rule 11).
- `crate::schema::tests::…` in a moved file is `crate::schema::fixtures::…` in the core.

## The script

`node scripts/core-step-4.mjs` from the repository root. It reads the tree, writes the tree and runs `cargo fmt -p mtg-grimoire -p grimoire-core`. A module whose file is already gone from `src-tauri/src` is skipped, so a second run changes nothing.

For each module on its list:

1. Split the file into items. **Stay**: an item with a `#[tauri::command]` attribute; an item whose code names `tauri::`, `AppState`, `AppHandle` or `WebviewWindow`; an item on the script's short list of rule-8 names; and a private item that only stay items call. **Refuse** if a moving item names a staying one.
2. Split `mod tests` the same way. A test stays if it names a staying item, the desktop, or a module that has not moved — directly or through a helper.
3. `git mv` the file to the core and write it without the stay items; write `src-tauri/src/<module>/mod.rs` with the glob re-export and the stay items. A module with nothing left behind becomes `pub use grimoire_core::<module>;` in `lib.rs`.
4. Drop each `use` leaf the half it sits in no longer names. Where a test module leaned on a dropped one through `use super::*`, import it there.
5. Widen to `pub` what `src-tauri` still names: an item, a method or a field that is private or `pub(crate)` in a moved file and is spelled in a remainder or in a module that did not move.
6. Rewrite the four paths that changed: `crate::sync::{get_meta, set_meta, set_meta_opt}` to `crate::sync_meta`, `crate::sync::with_write*` to `crate::state`, `crate::sync::lock_plain` to `crate::db`, `crate::schema::tests` to `crate::schema::fixtures`. Code only; a doc link is left as it was.

Then, once: `with_write` into `state.rs`, `prepare_database` into `schema.rs`, the two module maps, and the TypeScript tests that read a moved file as text.

**A branch that edited a moved file runs the script before it merges `main`**, so both sides have made the same move. What is left to merge is what the branch changed, and four files `main` edited by hand after its own run:

```bash
git checkout origin/main -- scripts/core-step-4.mjs scripts/lib/rs-items.mjs
node scripts/core-step-4.mjs
git add -A && git commit -m "chore(core): step 4's move, on this branch"
git merge origin/main
```

**Only a branch that edited a moved file needs it.** One that did not just merges `main`: git
follows the 51 renames.

**Driven on a scratch branch cut from `28258b21`** that changed a constant in `deck_todos`, a
sentence in its wrappers' helper, added a test there, and added a command to `sticky_notes` with
its handler entry. The script ran clean; the merge then reported seven conflicts in two kinds:

- **Four in files the branch never touched** — the core's `lib.rs`, `maintenance.rs` and
  `state.rs`, and `src-tauri/src/schema/mod.rs`. Those are the files edited by hand after the
  script on `main` (the docs the move made untrue, and the rebuild flag going home), so the
  branch's run and `main` differ there. **Take `main`'s**: `git checkout --theirs -- <file>`.
- **Three that were the branch's own changes, one hunk each**: the new function in the core's
  `sticky_notes.rs`, the new command in `src-tauri/src/sticky_notes/mod.rs`, and the edited
  sentence in `src-tauri/src/deck_todos/mod.rs`. In each the branch's side is the answer.

The constant and the new test in the core's `deck_todos.rs` merged without a conflict, as did
`desktop.rs`'s handler entry.

## Global Constraints

- **The desktop app must be unchanged.** No command is renamed, added or removed; `generate_handler!` is not edited; no SQL statement changes.
- **No schema rung, no DDL.**
- **No test is deleted or weakened.** `#[test]` and `#[tokio::test]` attributes are counted before and after, per crate.
- **A moved item's body is not edited**, with three exceptions, each named in the record: a path the move changed, a visibility `src-tauri` still needs, and `maintenance`'s sleep.
- `grimoire-core` gains no dependency it does not already resolve. It has no `tauri`; `cfg(target_…)`, `SystemTime` and `Instant` appear only under its `src/platform/`. The fence is not weakened.
- The `testing` feature stays off every host's `[dependencies]` line.
- **Never `cargo fmt --all`.**
- No agent deploys anything, and nothing here needs a deploy.
- Tests run once, at the end. Cargo is never run twice at once in this tree.

## Review Focus

- **A wrapper that calls a core function the glob does not carry.** A `pub(crate)` or private item a wrapper names fails to compile, which is loud; a wrapper whose name equals a core item's shadows it silently. The script refuses a remainder item whose name a moved `pub` item also has.
- **A behaviour that switches on `cfg(test)`** goes dark in `src-tauri`'s tests without a compile error. Every moved file is read for `cfg!(test)` and `#[cfg(not(test))]`.
- **`with_write` must still settle.** The managed wishlists armed, the token reconcile, the settle and the fence assertion, in that order, on both the bounded and the waiting path — `sync`'s existing tests of it stay in `sync.rs`, call it through the re-export, and must pass unedited.
- **An existing database.** The launch runs `prepare_database` from its new crate: a real database below head is upgraded by this branch and by `main` side by side and compared row for row.
- **The WASM compile.** 38 000 lines the browser target has never seen: `cargo build --lib -p grimoire-core --target wasm32-unknown-unknown`, and the fence over all of it.

## Tasks

### Task 1 — the splitter and the script

**Files:** create `scripts/lib/rs-items.mjs`, `scripts/lib/rs-items.test.mjs`, `scripts/core-step-4.mjs`.

- [x] `rs-items.mjs`: `split(src)` → header, items (text, kind, name, visibility, attributes), tail; `inner(item)` for a braced item's body; `code(text)` with comments and literals blanked. `split` throws if its pieces do not rejoin to the input.
- [x] `rs-items.test.mjs` (vitest, which already runs `scripts/**/*.test.mjs`): a raw string holding a `}`; a char literal beside a lifetime; a nested block comment; `const X: T = T { .. };`; an attribute with brackets in a string; and the lossless property over every `.rs` file under `src-tauri/src` and `crates/grimoire-core/src`.
- [x] `core-step-4.mjs`: the six steps above, with `--dry` printing what would stay, move and widen, per module, without writing.
- [x] `node scripts/core-step-4.mjs --dry` — read every "stays" line against the tables above.

### Task 2 — run it, and make both crates compile

- [x] `node scripts/core-step-4.mjs`.
- [x] `cargo check -p grimoire-core --all-targets`, then `cargo check -p mtg-grimoire --all-targets`. **A compile error is fixed in the script, never in the output**, and the script is run again from a clean tree (`git checkout -- . && git clean -fd crates src-tauri/src`).
- [x] `cargo clippy --workspace --all-targets -- -D warnings`; `cargo check -p mtg-grimoire --locked`.
- [x] Commit the script, then its output, as two commits.

### Task 3 — the fence and the other targets

- [x] `cargo test -p grimoire-core platform::` — the source fence over the moved files.
- [x] `CC_wasm32_unknown_unknown=… cargo build --lib -p grimoire-core --target wasm32-unknown-unknown`, then `clippy` for it with `-D warnings`.
- [x] `cargo tree -p mtg-grimoire -e features,normal,build -i grimoire-core` prints `default` and nothing else.

### Task 4 — the suites

- [x] Count `#[test]` and `#[tokio::test]` attributes per crate, before (from `main`) and after.
- [x] `cargo test --workspace` in the foreground.
- [x] The TypeScript side: `npm run test:run` (sharded if a long run is killed), `npm run lint`, `npm run build`.
- [x] `npx vitest run scripts` for the route, toolchain and splitter tests.

### Task 5 — an existing database, and the window

- [x] Two byte copies of the main checkout's dev data folder; one launched under `main`'s binary and one under this branch's; compare `user_version`, table and row counts, `foreign_key_check`, `integrity_check`, and every table row for row.
- [x] `tauri dev` over a third copy (the `app` lock; the `running-the-app` skill): `startup_status`, a search, a deck read, a deck made, renamed and deleted, a collection add and remove, a wishlist add, the mirror's pass after a write.

### Task 6 — the record

- [x] `docs/reference/light-app.md` §6.4: what moved, what stayed and why, every count and timing above.
- [x] `crates/grimoire-core/CLAUDE.md`, `src-tauri/CLAUDE.md`, the root `CLAUDE.md`'s table row, both `lib.rs` module docs, the spec's §2.8 note.
- [x] Issue #761: step 4 ticked with what it measured; step 5's and step 6's lines gain what this step left them.

### Task 7 — verify and ship

- [x] `npm run verify` pieces, each in the foreground; a fresh reviewer over the script and the remainders.
- [ ] The `shipping-a-branch` skill: PR linked to #761, auto-merge armed.

## What step 5 inherits

`reconcile` and `tags/`, whole; `deck::bracket_reads` and its tests; `collection_source::with_write_owned`; `reset::clear_cache`; the tests of this cluster that name `images`, `index` or `sync_engine::client`; and everything step 3's list already gave it.
