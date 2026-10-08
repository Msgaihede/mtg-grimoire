# Architecture

The boundaries the codebase is built around. Moved out of the root [`CLAUDE.md`](../../CLAUDE.md)
without changing the wording. The root file keeps a short summary. Each area's own `CLAUDE.md`
has the binding rules for that area (the index is in the root file).

## Rust supplies facts, TypeScript draws conclusions

- **Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache). **TS owns domain
  logic** (deck validation, import/export parsing). Rust supplies _facts_; TS draws
  _conclusions_. Keep that boundary.

## Two Rust crates: does it know about a window?

- **The Rust is two crates, and the line between them is "does it know about a window".**
  `crates/grimoire-core` is the engine — the schema, the decks, the collection, the wishlist, the
  search — and has no `tauri`; `apps/desktop/src-tauri` is the desktop: the window, the mirror, the updater,
  what still reaches a network, and **every `#[tauri::command]`**. A command's function is
  written in the core over `&Connection`; its wrapper is written in
  `apps/desktop/src-tauri/src/<module>/mod.rs`, which re-exports the core's module of that name with a glob.
  So `crate::deck::…` in `apps/desktop/src-tauri` is the core's `deck` unless that file defines the item.
- **The wire between the two is mirrored by hand.** `packages/ui/lib/ipc.ts` is the TypeScript
  mirror of the Rust structs the commands return, and `packages/ui/lib/ipc.test.ts` reads the Rust
  source text and fails on drift. The light app's Android host (`apps/light/src-tauri`) and the web
  host (`crates/grimoire-web`) link the same core, so they answer the same mirror.
- Where each folder sits, and where it was before 2026-10-08:
  [repository-layout.md](../reference/repository-layout.md).
- Details: [`crates/grimoire-core/CLAUDE.md`](../../crates/grimoire-core/CLAUDE.md) (the engine,
  `platform/`, how a module moves there) and [`apps/desktop/src-tauri/CLAUDE.md`](../../apps/desktop/src-tauri/CLAUDE.md).

## Export writing lives on both sides, and a golden corpus keeps them equal

- **Export _writing_ is the one thing that lives on both sides, by design, and the golden fence
  is what makes it legal.** The plain-text mirror is maintained by a Rust thread and cannot ask
  the page to render a file, so `apps/desktop/src-tauri/src/transfer/` is a second implementation of
  `packages/ui/features/transfer/export/`. The alternative — move the writer to Rust and have the export
  dialog fetch its text over IPC — turns the dialog's live field preview into a round trip per
  checkbox and strands the writer-to-parser round-trip test vitest owns. So both stay, and
  **`packages/ui/features/transfer/__golden__/` is the fence that turns drift into a red build** rather
  than into a file that quietly disagrees with the dialog: one committed corpus, one committed
  golden set, both suites asserting byte equality against it. **Parsing did not follow** — there
  is no Rust parser, because the mirror never reads a file back. Full record:
  [text-mirror.md](../reference/text-mirror.md).

## Design documents

- Spec: [`docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`](../superpowers/specs/2026-08-04-mtg-collection-tracker-design.md)
- Research (live-verified facts, incl. Scryfall breaking changes): `docs/superpowers/research/`
- Plans: `docs/superpowers/plans/` — execute in order, check off steps as you go.
