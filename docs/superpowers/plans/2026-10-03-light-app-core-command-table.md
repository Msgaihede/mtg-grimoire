# The shared core: the command table — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** one declaration per command a host with no window answers, one entry point — `grimoire_core::dispatch` — and a fence that keeps the table and the desktop's `generate_handler!` one list's worth of truth.

**Architecture:** a `macro_rules!` block in `crates/grimoire-core/src/commands.rs` expands each line into an argument struct, an arm of `dispatch` and a row of `TABLE`; the desktop keeps its typed wrappers; `src-tauri/src/command_table.rs` holds the two explicit lists and the parity tests.

**Tech Stack:** Rust; `serde`/`serde_json`; `platform::spawn`.

**Spec:** [`docs/superpowers/specs/2026-10-01-light-app-android-and-web-design.md`](../specs/2026-10-01-light-app-android-and-web-design.md) §2.2 (*a command is declared once, in a table in the core*) and §2.4. **Tracking issue:** Msgaihede/mtg-grimoire#761, phase 2.

## Surveyed before the decision — 2026-10-03

Every `#[tauri::command]` under `src-tauri/src`, read by script with what its body touches:

| | |
| --- | --- |
| Registered by `generate_handler!` | 257 |
| Thin wrappers — one core call on the read connection / in `with_write` / in `with_write_owned` | 89 / 93 / 17 |
| Reach a network or the sync lane | 13 |
| Status reads and housekeeping | 13 |
| Name the desktop (windows, updater, mirror, dialogs, the change mask, the scanner's raw body) | ~30 |

## Decisions — Markus, 2026-10-03

| Question | Answer |
| --- | --- |
| How much goes in now | **The machinery and the reads**: every kind in `dispatch`, the parity test with every command not yet in the table on an explicit list (desktop-only ones with a reason each), and the reads in it — over everything a light host can answer now, and over the machinery alone |
| How a command is declared | **A `commands!` `macro_rules!` table** — over a hand-written match and structs |

## Global Constraints

- **The desktop does not change**: its wrappers stay, and nothing it does goes through `dispatch`.
- **A table entry's name and arguments are its desktop wrapper's** — they are the wire.
- **No proc-macro crate, no build step.**
- **Never `cargo fmt --all`**; never two cargo runs at once in one tree.

## Review Focus

1. **An argument whose name or case differs from the wrapper's** — a host's call refused. Pinned by `every_command_in_the_table_takes_its_wrappers_arguments` and by the kinds test's camelCase/snake_case pair.
2. **A desktop command nobody placed** — the lists stop describing the app. Pinned by `every_registered_command_is_in_the_table_or_on_one_list`.
3. **A kind nothing in the real table uses** — macro code nothing compiles. Pinned by `commands::tests::kinds`.
4. **A body that answers differently from its wrapper** — drafted from the wrapper itself, and three reads checked through `dispatch` against their functions.

---

### Task 1: the machinery

**Files:** `crates/grimoire-core/src/commands.rs` (new), `crates/grimoire-core/src/lib.rs`

- [x] `Kind`, `Entry`, `TABLE`; `dispatch(&Arc<State>, name, args: Value, body: Option<Vec<u8>>) -> Result<Value, String>`; the `commands!`, `run!` and `kind!` macros; refusals in words; `nothing_is_held_across_a_call`.
- [x] The kinds test table (`commands::tests::kinds`) — one command of each kind — and `every_kind_answers_through_its_own_arm`, `a_call_the_table_cannot_answer_is_refused_in_words`.
- [x] Each arm states that its body answers `Result<_, String>`: `Ok(stored(conn))` alone leaves the error type open.

### Task 2: the reads

**Files:** `scripts/core-command-table.mjs` (new), the `commands!` block

- [x] Drafted from the wrappers: 88 reads — the survey's 89, less `prefetch_images` and `prewarm_collection` (they start a background fetch), plus `card_holdings` (a doc-comment word had excluded it). Five by hand: `marketplace_feed_status`, `error_log_list`, and three whose inline `mod commands` renamed what it imported.
- [x] Names the bodies' modules imported privately — `Marketplace`, `CardFilters`, `WishlistQuery` — imported at the top of `commands.rs`.
- [x] `the_reads_answer_what_their_functions_answer`, `no_command_is_declared_twice`.

### Task 3: the fence

**Files:** `src-tauri/src/command_table.rs` (new, test-only), `src-tauri/src/lib.rs`

- [x] `DESKTOP_ONLY` (16, each with its reason) and `NOT_YET` (153).
- [x] `every_registered_command_is_in_the_table_or_on_one_list`, `every_command_in_the_table_takes_its_wrappers_arguments`, `every_desktop_only_command_says_why`.
- [x] Mutated — a renamed argument, a name taken off `NOT_YET` — and both went red. **The arguments test found a real case first**: told apart by parameter *name*, Tauri's own parameters swallowed `price_movers`' `window`; they are told apart by their `tauri::` type now.

### Task 4: verify, record, ship

- [ ] Every Rust gate, both clippies, the WASM build; lint over the new script.
- [ ] A fresh reviewer subagent (Opus, read-only).
- [x] Docs: `crates/grimoire-core/CLAUDE.md` (*The command table*), `src-tauri/CLAUDE.md` (a new command's third decision), `docs/reference/light-app.md` §6.11, the spec's §2.4 note, the root `CLAUDE.md` row.
- [ ] PR linked to #761 once step 7's #773 has merged, auto-merge and auto-fix; #761's table line.
