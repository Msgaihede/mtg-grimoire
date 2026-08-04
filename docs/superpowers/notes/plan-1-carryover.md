# Plan 1 Carryover Notes (2026-08-04)

Final whole-branch review verdict: **approved with fixes — all applied and re-verified** (commit `fa9875e`).
This file preserves the triage that future plans must honor. Full history: git log `9dae8e3..fa9875e`.

## Parked residuals (adjudicated at plan close, non-blocking)

1. **Exit checkpoint blocks on the write mutex** (`lib.rs` checkpoint_on_exit): quitting mid-ingest parks the (window-less) process up to ~44 s before the WAL TRUNCATE. Ruling: safer than being killed mid-transaction; rare edge (quit during a sync). Revisit in Plan 2 with a bounded try_lock retry.
2. **`mergeStatus` doesn't carry `lastIngestSkipped`** across unreadable polls — invisible today (nothing renders it). **Plan 2 MUST fix when it surfaces the field.**
3. Trivial doc drift: duplicated FTS paragraph in `swap_staging` docs; "four database-derived fields" (now five) in ipc.ts/useSync.ts; search.rs "three interpolations" (now four).

## MUST-DO before/during Plan 2 (images & card browsing)

- **Tighten `csp: null`** in tauri.conf.json BEFORE the custom image protocol ships (ledgered since Task 1).
- **`image_uris` needs a real column**: 112,324 printings carry image URIs only inside `raw`, 4,082 in `faces`, **162 have none at all** (placeholder art path required). Add via a **v2 migration step** — v1 `CARDS_COLUMNS` is FROZEN (see CLAUDE.md hard rules; `create_staging` self-adapts via PRAGMA table_info).
- **Route image-protocol DB reads through `db_read`** (read-only connection added for exactly this; search already uses it). Consider also routing `sync::status` reads through it — would keep header numbers live mid-sync and delete the mergeStatus special case.
- **Any `UPDATE cards` outside the ingest** (e.g. image bookkeeping) requires an FTS rebuild only if it touches indexed columns (name/type_line/search_text) — prefer a separate table for image-cache state instead.
- Sets pagination A→B→A cycle guard (5-line page cap) when touching scryfall.rs.
- Two-instance collision (shared db + tmp gz, no single-instance guard) — image cache widens the surface; add a single-instance plugin or lock file.
- Error taxonomy: `RateLimited` flattens to a string; Plan 2's image fetcher needs real 429 backoff (30 s per Scryfall policy).
- Deep-OFFSET paging measured at 595 ms @ offset 100k (reachable now that capped totals don't stop the pager) — if Plan 2's grid pages hard, switch to keyset pagination (`WHERE (name,id) > (?,?)`).

## Plan 3 notes (collection)

- **NO enforced FK to `cards.id`** — `cards` is dropped wholesale every sync (CLAUDE.md hard rule; regression-tested). Soft reference + denormalized set_code/collector_number/lang per spec §6.
- Per-entry valuation must read the `prices` JSON blob by finish — `price_usd` is a display/sort fallback chain (nonfoil→foil→etched) and would price a nonfoil at foil rates.
- `--chart-*` tokens are stock greys, near-invisible on the dark bg (value-stats charts will need theme work).

## Plan 4 note
- `game_changer: true` has no fixture coverage (bracket estimate feature should add one).

## Plan 6 notes (polish/distribution)
- README still stock-adjacent; overlay focus management; `dir_writable` empty-dir litter in Program Files fixed, but installed-build behavior deserves a pass; eslint `recommended-latest` enables 14 React-Compiler rules at error severity (documented judgment call); measure second-sync file growth (predicted ~2× to ~1.7 GB; decide post-swap VACUUM — which REQUIRES `create_fts` after — vs shrinking `raw`).

## Perf baselines (live db, 116,568 cards, this machine)

- Ingest: 77.4 MB download + full ingest = 44 s; db 880 MB (raw column 67.5%).
- Search: browse 10 ms (was 367); ranked "lightning bolt" 0.3 ms; broad ranked "creature" ~278 ms; deep offset 100k ≈ 595 ms.
- Second launch: zero network (throttle), instant.
