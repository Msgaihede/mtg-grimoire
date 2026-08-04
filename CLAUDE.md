# MTG Collection Tracker

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage,
Scryfall as the only external dependency.

## Commands
- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild)
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests

## Data & sync (measured against the live Scryfall API, 2026-08-04)
- Data dir is `<exe dir>/data`, falling back to `%APPDATA%/com.mtgcollection.tracker/data`.
  **Under `tauri dev` the exe is `src-tauri/target/debug/`, so the database is
  `src-tauri/target/debug/data/mtg.db`** — not `src-tauri/data/`. Delete that `data/`
  folder to force a clean first-run sync. All three locations are gitignored.
- A cold sync takes ~45 s (77 MB download + streaming ingest + FTS rebuild) and yields
  ~116.5 k cards / ~1 050 sets. `mtg.db` is ~880 MB, two thirds of it the `raw` JSON
  column.
- The app never closes its SQLite connection, so a `mtg.db-wal` the size of the ingest
  (~857 MB) outlives the process until something opens and cleanly closes the file.
- A second launch inside 24 h makes **no network call at all** — the throttle returns
  before the ETag check and writes nothing, so `last_check_at` does not move.

## Architecture (read the spec first)
- Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`
- Research (live-verified facts, incl. Scryfall breaking changes): `docs/superpowers/research/`
- Plans: `docs/superpowers/plans/` — execute in order, check off steps as you go.
- **Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache). **TS owns domain
  logic** (deck validation, import/export parsing). Keep that boundary.

## Hard rules
- Scryfall bulk data is gzipped **JSONL** (one object/line). Old JSON-array endpoints 404.
- Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- `cards.oracle_id/cmc/type_line` are NULLABLE. `collector_number` is TEXT. Prices are
  decimal strings. `legalities` is JSON (23 keys, grows). Finishes: enum, never boolean.
- npm `xlsx` is banned (CVEs). TypeScript stays on 6.0.x until TS 7.1.
- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json).
  The app palette maps `muted`/`accent` to **text** colours, so rewrite a vendored
  component's `bg-muted`/`bg-accent` surfaces to `bg-surface` (stock `bg-muted` renders
  text on the same colour — a stock `TabsList` has invisible labels). `text-muted-foreground`
  and `text-accent-foreground` already resolve correctly.
- Work on `main`, commit small after each task/step with `feat:`/`fix:`/`chore:`/`test:`.
- Tests: cover logic that can break (parsers, validation, sync). No ceremony tests.

## Working style (user preferences)
- Ultracode/dynamic workflows for large parallelizable work; subagents use Opus 5.
- Superpowers flow: brainstorm → spec → plan → subagent-driven implementation.
