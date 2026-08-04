# MTG Collection Tracker — Design Spec

**Date:** 2026-08-04
**Status:** Approved (stack: Tauri chosen by user over Electron recommendation)
**Research:** see `docs/superpowers/research/2026-08-04-*.md` — all facts below were verified live against Scryfall, npm, and official rules sources on 2026-08-04.

## 1. Overview

A portable Windows-first desktop app for tracking a Magic: The Gathering collection. Core capabilities: owned-card tracking (duplicates, alternate arts, finishes, conditions), wishlist, a drag-and-drop deckbuilder with format validation, global card search with prices, import/export (CSV, Excel, PDF, deck-list text formats), and offline-capable card browsing backed by Scryfall bulk data.

Single user, fully local. The only external dependency is the Scryfall API (card data + images). No accounts, no telemetry, no paywalled anything (Scryfall policy forbids paywalling their data).

### Non-goals (v1)

- Non-English printing tracking (Scryfall `all_cards` is 5× the size for translations only; the schema reserves a `lang` column per collection entry so this can be added later)
- Marketplace integration (buying/selling), storefront pricing
- Multi-user/sync/cloud features
- Graded-slab tracking beyond a simple nullable grading field
- Life counter / game-play features

## 2. Stack

**Tauri 2.11 + React 19 + TypeScript 6** (user decision; Electron was the research recommendation, Tauri the runner-up).

| Layer | Choice | Notes |
|---|---|---|
| Shell | Tauri 2.11 (Rust) | Portable single exe ~10 MB; WebView2 (preinstalled Win11, most Win10) |
| DB | rusqlite, bundled SQLite with FTS5 | **Not** tauri-plugin-sql — it double-serializes rows through JSON IPC (measured ~11× slower). Verify FTS5 build flags at scaffold time. |
| HTTP (Rust) | reqwest (streaming) | Bulk download, image fetch. UA + Accept headers mandatory. |
| Ingest | flate2 GzDecoder → BufReader lines → serde_json | Streaming JSONL, constant memory |
| Frontend | React 19, TypeScript 6.0.x | TS 7 lacks a stable programmatic API until 7.1 (typescript-eslint can't run on it) |
| Styling | Tailwind CSS v4 + shadcn/ui with `npx shadcn init -b radix` | `-b radix` is mandatory — shadcn's CLI default flipped to Base UI (still RC) in July 2026 |
| Server state | TanStack Query 5 (queryFn = Tauri `invoke`) | Dedup, cache invalidation after mutations, `useInfiniteQuery` feeds virtualizer |
| UI state | zustand 5 | Deck draft, filters, selection, panels |
| Virtualization | @tanstack/react-virtual 3 | Row virtualizer over `ceil(total/columns)`, 5:7 card frames |
| Drag & drop | @atlaskit/pragmatic-drag-and-drop 2 (+hitbox, auto-scroll, react-drop-indicator) | dnd-kit stable is unmaintained (no publish since 2024-12), react-dnd dead. Apache-2.0 NOTICE in licenses screen. |
| CSV | papaparse 5 | Header-name parsing, per-row warnings |
| Excel | exceljs 4.4 | npm `xlsx` is **banned** (frozen 0.18.5, unpatched CVEs). Fallback: write-excel-file/read-excel-file. |
| PDF | @react-pdf/renderer (primary; pdfmake reserve) | Electron's printToPDF is unavailable in Tauri. Verify at implementation; WebView2's native print-to-PDF via Tauri is a possible upgrade if exposed. |
| IPC types | tauri-specta (verify current version) or hand-maintained shared types | One source of truth for command payloads |
| Tests (Rust) | cargo test | Sync, ingest, DB, image cache |
| Tests (TS) | Vitest 4 + @testing-library/react (jsdom) | Domain logic: validation, import/export parsers, components |
| E2E | tauri-driver + WebDriver (smoke only) | Marked risky; verify Windows story during implementation. Keep minimal. |

**Alternatives considered** (full trade-offs in `2026-08-04-stack-eval.md`): Electron 43 (recommended by research: deepest ecosystem, zero-native-dep `node:sqlite`; ~350 MB, ZIP-first distribution), .NET 10 + Avalonia (single-file exe, weaker web-style UI ecosystem), Wails v3 (beta days old), Flutter (ruled out: no single exe on Windows).

**Known Tauri trade-offs accepted:** MSVC toolchain; 3–10 min release builds; no cross-compilation; WebView2 absent on Win10 LTSC/Server (out of scope — target is standard Win10/11); Rust/TS boundary discipline required.

## 3. Architecture

```
┌─────────────────────────── Tauri app (single exe) ───────────────────────────┐
│  React renderer (WebView2)          Rust core                                │
│  ┌───────────────────────┐  invoke  ┌─────────────────────────────────────┐  │
│  │ Views: Search /        │ ───────► │ Commands: search, card, collection, │  │
│  │ Collection / Wishlist / │ ◄─────── │ wishlist, decks, sync, images,      │  │
│  │ Decks / Deck editor /   │  events  │ import-commit, settings             │  │
│  │ Settings                │          ├─────────────────────────────────────┤  │
│  │ Domain logic (TS):      │          │ SQLite (rusqlite + FTS5)            │  │
│  │ deck validation,        │          │ Scryfall sync (tokio task)          │  │
│  │ import/export parsers,  │          │ Image cache + custom protocol       │  │
│  │ PDF/Excel/CSV writers   │          │ Migrations reconciler               │  │
│  └───────────────────────┘          └─────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Responsibility split (the load-bearing boundary):**

- **Rust owns data plumbing**: SQLite, FTS5 search, Scryfall sync/ingest, image cache + serving, file dialogs/writes. Long-running work runs in tokio tasks emitting progress events; the UI never blocks.
- **TypeScript owns domain logic**: deck/format validation, import format detection/parsing, export generation (CSV/Excel/PDF/deck text). This keeps the most intricate, most test-heavy logic in fast Vitest cycles, with card data supplied via IPC queries.

**Portable data directory:** `<exe dir>/data/` (DB, image cache, settings, deck cover images) — probe writability at startup; fall back to the OS app-data dir (with an in-app indicator of which location is active) for read-only placements. This makes the app truly run-anywhere including USB sticks.

## 4. Scryfall data pipeline

⚠️ **Breaking change (2026-07-20):** Scryfall bulk data is now **gzipped JSONL only** (`jsonl_download_uri`, `compressed_size`); the old `download_uri`/JSON-array files return 404. The `.gz` is a real file (`Content-Type: application/gzip`), *not* transport encoding — the HTTP client must not transparently decode, and must not double-decompress.

**Bulk file: `default_cards`** — 77 MB compressed / 594 MB raw / 116,568 printings. Every physical printing (all alternate arts, promos, showcases, serialized variants) with per-printing prices, legalities, and image URIs. `all_cards` adds only non-English translations at 5× the size — not needed (see non-goals).

**Startup flow:**
1. Launch instantly from the local DB. Never block on network.
2. Background check, at most once per 24 h (Scryfall regenerates ~21:00–21:45 UTC; prices update once daily): conditional GET `api.scryfall.com/bulk-data/default_cards` with `If-None-Match` → **304 = 0 bytes, done**. On 200, compare `updated_at`.
3. If newer: download `.gz` to temp file (resumable — origin supports Range; verify byte count against `compressed_size`), then stream-ingest: `GzDecoder → lines → serde_json → batched inserts (1–5k rows/tx)` into a **staging table, then atomic swap**. Old data stays queryable throughout. Progress events → UI toast/progress.
4. First run: same download but with a welcome/progress screen; app usable when done (~30–60 s on a normal connection).
5. **Refresh button** (in the header/settings): runs the same check on demand, shows "already up to date (checked Xs ago)" on 304.
6. After each successful ingest: fetch `/sets` (paginated, small) into a `sets` table — needed for `arena_code`/`mtgo_code` on deck export.
7. Poll `/migrations` (same cadence): `merge` → repoint collection/deck/wishlist rows to the new Scryfall ID; `delete` → flag affected rows for user review, never silently drop.

**HTTP conduct (hard requirements):** every `api.scryfall.com` request sends `User-Agent: MTGCollectionTracker/<version> (contact URL)` and `Accept` (403 without). Rate limits: 10/s general, 2/s for `/cards/search|named|collection`, 10/min for `/cards/manifest`; on 429 back off 30 s. `*.scryfall.io` (bulk + images) is explicitly unlimited; keep image fetching ≤10/s sustained anyway.

**SQLite:** `PRAGMA journal_mode=WAL; synchronous=NORMAL;` hot columns + raw JSON:

- `cards`: `id` PK, `oracle_id` **NULLABLE**, `name`, `lang`, `set_code`, `set_name`, `collector_number` **TEXT** (natural sort in queries — 9% are non-numeric: `741z`, `1★`, `A-123`), `rarity`, `layout`, `mana_cost` NULL, `cmc REAL` **NULLABLE** (fractional exists), `type_line` **NULLABLE**, `oracle_text` NULL, `colors` JSON NULL, `color_identity` JSON, `legalities` JSON (**23 keys and growing — never fixed columns**), `games` JSON, `finishes` JSON, `prices` JSON (6 keys: `usd, usd_foil, usd_etched, eur, eur_foil, tix` — decimal **strings**; documented `eur_etched` does not exist in data), `faces` JSON NULL, `illustration_id` NULL, `frame_effects` JSON NULL, `border_color`, `full_art`, `promo`, `promo_types` JSON NULL, `digital`, `released_at`, `edhrec_rank` NULL, `game_changer` NULL, `image_status`, `image_updated_at`, `raw` JSON (everything else).
  - Nullability driven by `reversible_card` layout: no top-level `oracle_id`/`cmc`/`type_line` — ingest falls back to `card_faces[0]` where sensible.
  - FTS5: `fts5(name, type_line, oracle_text, content='cards', tokenize='unicode61 remove_diacritics 2')`, face text concatenated in, **no `prefix=` option** (measured: no query benefit, 3.5× slower rebuild). ~3 ms prefix queries at 116k rows.
- `sets`: `code` PK, `name`, `arena_code` NULL, `mtgo_code` NULL, `set_type`, `released_at`, `icon_svg_uri`.
- `sync_meta` KV: ETag, `updated_at`, last check/ingest timestamps, schema version.

**Image resolution rule** (3.7% of cards have no top-level `image_uris`): use `image_uris` if present, else `card_faces[i].image_uris` per face (`transform`, `modal_dfc`, `double_faced_token`, `reversible_card`, `art_series` are faces-only; `split`/`adventure`/`flip`/`prepare` are top-level-only despite having faces; `meld` is top-level with **no** `card_faces`). Store/serve images **per face index**.

## 5. Image caching (hybrid)

Bulk data has image *URLs*, not images (full library at display size would be tens of GB; `png` = 161 GB).

- **Lazy + permanent**: fetch from `cards.scryfall.io` on first display, cache forever under `data/images/<variant>/<id[0..2]>/<id>-<face>.webp`, keyed/invalidated by `image_updated_at` (also re-fetch when `image_status` improves from `lowres`/`placeholder`).
- **Variants**: WEBP only — `thumb` (~9 KB, list rows), `grid` (~62 KB, card grids), `display` (~93 KB, detail/preview), `art` (deck covers). 39–48% smaller than the legacy JPGs, which the docs mark as being replaced.
- **Pre-warm**: a resumable background job keeps images for all collection/wishlist/deck cards cached (`thumb`+`grid`, `display` for deck cards) so the user's own cards browse fully offline. Worst-case full-library `thumb` cache ≈ 1.1 GB; pre-warm scope is far smaller.
- **Serving**: custom Tauri protocol (e.g. `mtgimg://<card>/<face>/<variant>`) with asset scope + CSP configured; renderer never touches paths. Cache misses trigger fetch + cache, and return the image when available (UI shows skeleton frames meanwhile).
- **Policy compliance** (Scryfall requires): show artist + copyright wherever `art`/`art_crop` is displayed (deck covers, headers); never distort/watermark/recolor card images; prices always labeled with as-of date; `tix` never summed with fiat.

## 6. Data model (user data)

Same SQLite DB, separate tables from `cards` (which is rebuilt on sync; user tables reference `cards.id` but survive rebuilds, with `set_code`+`collector_number`+`lang` denormalized as migration insurance).

- **`collection_entries`** — grain `(card_id, finish, condition, language, flags) → quantity`:
  `id` PK, `card_id`, `set_code`, `collector_number`, `lang`, `finish` (`nonfoil|foil|etched` — **enum, never boolean**), `condition` (`NM|LP|MP|HP|DMG`, default NM; `condition_original` preserves the imported string), `quantity`, `tradelist_quantity` (default 0), `purchase_price` NULL, `purchase_currency` NULL, `acquired_at` NULL, `acquisition_source` NULL (no competitor tracks this — cheap differentiator), `serial_number` NULL (serialized cards' 042/500 is not in Scryfall data), flags `altered|signed|proxy|misprint`, `grading` JSON NULL (`{company, grade, cert}`), `tags` JSON, `notes`, timestamps.
- **`wishlist_entries`**: `oracle_id`, `card_id` NULL (**null = "any printing"**, set = that specific printing), `quantity`, `preferred_finish` NULL, `notes`, timestamps.
- **`decks`**: `id`, `name`, `format_key`, `description`, `cover_kind` (`card_art|custom`), `cover_card_id` NULL, `cover_image_path` NULL (user file copied into `data/covers/`), `is_built` (reserves availability, never decrements collection), timestamps.
- **`deck_cards`**: `deck_id`, `card_id`, `zone` (`main|side|commander|companion|maybe`), `quantity`.
- **`deck_allocations`**: `deck_id`, `collection_entry_id`, `quantity` — computed availability ("3 of 4 owned, 2 reserved by Deck X"), Deckbox-style non-destructive semantics.
- **`format_specs`** (seeded data, not code): `key` = Scryfall legality key, `display_name`, `enabled_in_picker`, `deck_min`, `deck_max` NULL, `max_copies`, `sideboard_max`, `singleton`, `requires_commander`, `commander_rule`, `life`, `restricted_semantic` (`max_one` for vintage/timeless/oldschool; **`banned_as_commander`** for duel/tlr), `sort_order`. All 23 keys seeded (`future` excluded from picker), plus two pseudo-formats with no legality/pool checking: `casual` (no restrictions) and `limited` (40-card minimum, unlimited copies, no sideboard cap). Full per-format table in `2026-08-04-mtg-domain-rules.md`.

## 7. Features

### Global search
FTS5-backed instant search (name/type/text, diacritic-insensitive) + structured filters: colors/color identity (toggle chips with authentic mana symbols per the visual direction doc), set (searchable multi-select with set glyphs), mana value (0–8+ chips), type, rarity, format legality, price range, finish availability, owned/wishlist status. All filters combine (AND) and a **Reset all** control clears them; active filters are visible at a glance. Global actions (Refresh, sync status, settings) live in a top ribbon, not in views — see `2026-08-04-visual-design-direction.md` (binding). Results in a virtualized card grid (art view) or table view. Right-click/hover actions everywhere: add to collection (with finish/condition quick-pick), add to wishlist, add to open deck. Card detail pane: all printings of the oracle card with prices per finish (alternate-art gallery grouped by `illustration_id`), legality chips, rulings link.

### Collection
Virtualized grid/table of owned cards with the same filters + sort by name/set/price/date-added/quantity. Inline quantity steppers per finish/condition row. Aggregate header: total cards, unique cards, estimated value (USD/EUR, as-of date). Wishlist view mirrors this; "owned" badges appear in search once a wish is fulfilled.

### Deckbuilder
- Layout: deck zones (commander/companion/main/sideboard/maybeboard) center-stage grouped by card type or mana value, search panel docked right. Drag cards from search → zone, between zones, drag out to remove; click-to-add fallback everywhere (accessibility + speed).
- Live stats: mana curve, color pips, type counts, average MV, deck price, owned-vs-missing count (via allocations) with a "missing cards → wishlist" one-click.
- **Validation** (TS module, data-driven from `format_specs` + card `legalities`): deck size, copy limits (incl. `restricted` with correct per-format semantics), singleton with exact-phrase exceptions ("A deck can have any number of cards named…", Seven Dwarves ≤7, Nazgûl ≤9), commander eligibility (`legendary creature | Vehicle | Spacecraft w/ P/T | "can be your commander"`; Brawl adds planeswalkers; PDH computes uncommon-creature eligibility itself — Scryfall's `paupercommander` key only covers the 99), partner/Background/Doctor's-companion pairing rules, color identity via Scryfall's precomputed `color_identity` (plus the basic-land-type rule CR 903.5d), companion deck-condition checks, Old School per-printing legality. Issues render as precise, human messages ("Lightning Bolt is restricted in Vintage: max 1 copy; you have 3").
- Advisory (never blocking): Commander bracket estimate (Game Changer count via `game_changer` flag, mass-land-denial/extra-turn heuristics).
- Save/load to DB (autosave drafts); duplicate/archive decks.

### Import
- **Deck lists** (paste or file): Arena format (`4 Bonecrusher Giant (ELD) 115`, `Deck/Sideboard/Commander/Companion` headers — companion double-listed in sideboard is deduped; localized headers accepted; headerless blank-line split), MTGO `.txt`, plain "4x Name" lists with `SB:` prefixes, common site flavors (`*CMDR*`, `[Commander]`, backticked headers). Multi-face separators `/`, `//`, `///` normalized to `//`. Set codes resolved via `arena_code ?? code`.
- **Collection CSV**: auto-detect by signature columns (Moxfield, Archidekt, ManaBox, Deckbox, Dragon Shield, TCGplayer, MTGGoldfish; exact headers in the research doc), always parsed by header name, BOM/`sep=,`/CRLF handled, condition strings normalized through a synonym table (originals preserved). Unknown CSVs → column-mapping wizard.
- **Excel**: same pipeline via exceljs sheet → rows.
- Every import shows a **preview with per-row warnings** (unmatched cards, fuzzy set matches, unknown conditions) before committing; nothing writes without confirmation.

### Export
- **CSV**: Moxfield-compatible (verbatim headers) + a full-fidelity native format (all entry fields incl. Scryfall ID).
- **Excel**: styled workbook (collection or deck) with summary sheet + data sheet.
- **PDF**: deck sheet (cover art + artist credit, zone lists, curve, prices) and collection report via @react-pdf/renderer.
- **Deck text**: Arena (set/collector numbers, leading zeros stripped), MTGO, plain text — clipboard or file.

### Previews & polish
Dark card-game aesthetic (Tailwind v4 OKLCH tokens, shadcn/ui components). Deck gallery of cover-art cards (custom art or any card's art, artist credited). Hover previews with full card image (both faces for DFCs, flip animation). List previews suitable for screenshots/sharing.

## 8. Error handling

- **Network**: all Scryfall failures are non-fatal — app runs from local data; sync retries with backoff next window; Refresh surfaces errors as toasts with detail. Downloads resume via Range on retry.
- **Ingest**: staging-table swap means a crash mid-ingest leaves the previous dataset intact; byte-count verification before parse; per-line parse errors logged and skipped with a count surfaced (not silently swallowed).
- **User data safety**: user tables never dropped on sync; migrations reconciler flags (never deletes) rows whose card ID vanished; DB backed up (file copy) before schema migrations; WAL survives crashes.
- **Imports**: preview-then-commit; committing is a single transaction.
- **Images**: fetch failures render as card-back placeholder with retry; cache is disposable (deleting `data/images` is always safe).

## 9. Testing

- **Rust (cargo test)**: ingest against fixture JSONL covering every gotcha layout (`reversible_card` missing oracle_id/cmc/type_line, `meld` no-faces, `transform` faces-only images, etched-only printings, fractional cmc, `1★` collector numbers); ETag/304 sync logic (mocked HTTP); staging swap atomicity; migrations reconciler; image path/invalidation logic.
- **TS (Vitest)**: the domain core — format validation matrix (per-format specs, restricted semantics, singleton exceptions, partner/companion/color identity cases), every import parser against real-world sample files, export round-trips (export→import = identity), condition normalization; component tests for deckbuilder interactions and search filters.
- **E2E (tauri-driver)**: minimal smoke — launch, search, add to collection, build small deck, export. Skipped if tauri-driver proves unstable on Windows (noted risk).
- Coverage philosophy per user instruction: good coverage of logic that can break, no ceremony tests.

## 10. Distribution & CI hygiene

- Primary artifact: single portable `MTG Collection Tracker.exe` (Tauri portable build); no installer required. Optional MSI/NSIS later if wanted.
- `data/` beside the exe (with AppData fallback) keeps it portable.
- Release build via `cargo tauri build`; debug loop via `cargo tauri dev` (Vite HMR).
- `npm run build && npm run lint && npm test && cargo test` (wired as a single verify script) before every commit; commit small and often to `main` with imperative messages.
- Licenses screen: Apache-2.0 NOTICE (pragmatic-drag-and-drop), Scryfall attribution ("data © Scryfall, card images © Wizards of the Coast"), no Scryfall logo use.

## 11. Risks & open items (tracked into the implementation plan)

1. **FTS5 in rusqlite bundled build** — confirm feature flags produce FTS5 + unicode61 with `remove_diacritics 2` (scaffold-time spike, first thing).
2. **PDF fidelity** — @react-pdf/renderer has its own layout engine (not HTML/CSS); if deck sheets fall short, evaluate WebView2 native print-to-PDF exposure or pdfmake.
3. **tauri-driver e2e on Windows** — unverified; treat e2e as optional smoke, don't block on it.
4. **tauri-specta version compatibility** with Tauri 2.11 — verify; fall back to hand-maintained shared types.
5. **Alchemy `Y`-set codes on Arena import** — research couldn't fully verify; accept-and-log unknown set codes rather than failing.
6. **Ingest throughput in Rust** — expected ≥ the measured 171 MB/s Node baseline; benchmark once during scaffold.
