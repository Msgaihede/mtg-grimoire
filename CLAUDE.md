# MTG Collection Tracker

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage,
Scryfall as the only external dependency.

## Commands
- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild)
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests

## Verifying UI in the real app (do this, not just tests)
Every UI task in Plans 2–3 found something the suite could not: a clipped reason line, a
tile that said nothing until you searched again, a header behind the scroller. Drive the
real window over CDP.

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
npm run tauri dev
```
Then from another shell, `scripts/cdp.mjs` (no dependencies, Node's built-in WebSocket):
`eval` · `click <css>` · `text <visible text>` · `key Escape` · `type` · `size 1024 768` ·
`media prefers-reduced-motion reduce` · `shot out.png` · `console out.jsonl` (stays
attached; records `Log.entryAdded` **and** `Runtime.consoleAPICalled` — a run that watches
only one reports a clean console it never looked at).

Seed and clean fixtures with `node:sqlite` straight into `src-tauri/target/debug/data/mtg.db`
**while the app holds it** (WAL allows it). Delete every seeded row afterwards — `data/` is
the user's, and it is never committed.

## Data & sync (measured against the live Scryfall API, 2026-08-04/05)
- Data dir is `<exe dir>/data`, falling back to `%APPDATA%/com.mtgcollection.tracker/data`.
  **Under `tauri dev` the exe is `src-tauri/target/debug/`, so the database is
  `src-tauri/target/debug/data/mtg.db`** — not `src-tauri/data/`. Delete that `data/`
  folder to force a clean first-run sync. All three locations are gitignored.
- A sync yields ~116.6 k cards / ~1 050 sets from a 77 MB download. **Timings, measured
  2026-08-05 over three live forced syncs (debug build):** `checking` <1 s · `downloading`
  ~2.5 s · `ingesting` **~81 s** · `reclaiming` ~6 s · `sets` ~5 s — **92–99 s end to end**.
  The old **44.8 s** figure predates schema v3: the ingest now gzips `raw` on the way in,
  and that is where the extra minute went. A run that finds nothing new is **1.8 s**.
- `mtg.db` was **2.02 GB** and is **547 MB** after the two things Plan 3 added: the one-time
  `compacting` conversion (which reclaimed a 996 MB freelist) and gzip `raw`
  (**622 MB → 235 MB**, 38 % of the original — not the quarter that was estimated). A
  full re-ingest afterwards leaves the file within 0.03 % of that and the freelist at **0**,
  which is the post-swap `incremental_vacuum` doing its job.
- The app never closes its SQLite connection, so a `mtg.db-wal` the size of the ingest
  (~857 MB) used to outlive the process. `RunEvent::Exit` now runs
  `PRAGMA wal_checkpoint(TRUNCATE)`, and `journal_size_limit` caps the file at 64 MB.
- A second launch inside 24 h makes **no network call at all** — the throttle returns
  before the ETag check and writes nothing, so `last_check_at` does not move.
- A **forced** Refresh skips only the throttle, not the ETag/`updated_at` check: if the
  bulk file has not changed it answers "Already up to date" in well under a second and
  emits nothing but a `checking` phase. To exercise a real ingest, clear `bulk_etag` *and*
  `bulk_updated_at` from `sync_meta` — clearing the etag alone still short-circuits.
- Searches keep answering through every second of a sync — 20 timed searches across one,
  every one correct, none stalled (that is what `db_read` bought).
- The ingest **commits every 2 000 rows and releases the write connection between batches**,
  so a collection edit during a sync waits one batch, not one sync. `ingest_gz` takes
  `&Mutex<Connection>` for exactly that reason. **Measured mid-ingest: 10 `collection_add`
  calls, 4–7 ms each, 0 `BUSY` refusals.** A killed ingest therefore leaves a *committed*
  `cards_staging`; `prepare_database` drops it at the next launch, because the ETag that
  would short-circuit the next check is written only after a *successful* ingest.
- `cards.raw` is a **gzip BLOB** from schema v3 (the column is still *declared* `TEXT` — v1
  is frozen — and SQLite's TEXT affinity leaves a BLOB alone). `json_extract` over it is a
  hard error, not a NULL: read it with `CAST(raw AS BLOB)` and `card_row::raw_json`.
  Nothing reads it at runtime; `artist` has had a column since v3. The v3 migration does
  **not** rewrite existing rows — the corpus converts on the next sync's swap.

## Image cache (measured 2026-08-04, live)
- Files live at `<data dir>/images/<variant>/<id[0..2]>/<id>-<face>.webp`; `image_cache`
  rows and files stay 1:1, and the row's `source_uri` — Scryfall's `?<epoch>` cache-buster
  — is the only invalidation signal. Deleting `data/images` is always safe.
- A `grid` image averages **59.6 KB**. 600 browsed cards cost ~36 MB, so all 116 k
  printings at `grid` would be ~7 GB — which is why Plan 3's pre-warm is scoped to what
  the user owns rather than to the database.
- Warm serve **2–3 ms**, cold single image **~127 ms**, cold first screenful **~1.8 s**
  after the query lands (6 in flight, 100 ms apart).
- A page of search results warms itself: `images::prefetch_images` takes front faces only,
  caps the batch at 100, and is fire-and-forget — it resolves when the work is *queued*.
- A printing with no art anywhere (162 of them) is a **200 with an SVG placeholder** at the
  variant's exact dimensions, never a 404 and never a cache row. Only a real failure is an
  error: 502 for a failed fetch, 503 + `Retry-After` for a rate limit.
- `mtgimg:` is an `img-src` and nothing else — a `fetch()` at it fails CORS by design (no
  `Access-Control-Allow-Origin`, because an `<img>` load is no-cors). Read images with
  `<img>`, never with `fetch`.
- A card image URI with no `?<epoch>` cache-buster is **refused at resolution** — it is
  uncacheable by construction, so it resolves to the no-image placeholder and never to
  bytes. This heals itself: the printings that publish `errors.scryfall.com/soon.jpg` in all
  four slots were **eight** on 2026-08-04 and are **four** (`mic 55`–`58`) on 2026-08-05,
  because a sync rewrites `image_uris` and a URI that gains a cache-buster becomes
  fetchable. No code is involved; do not build a re-fetch path for it.
  `cards.scryfall.io` is the **only** host images are fetched from; an off-host URI is
  refused and warned about once per process. A placeholder is served `no-store` (it is the
  one 200 whose content is meant to change), real bytes `max-age=86400`.
- Images are fetched **once per key** even when a screenful asks at the same moment
  (`Cache`'s per-key mutex + a re-read of the disk). The waiter re-reads rather than being
  handed the bytes, so it degrades to a second fetch when the write connection was busy or
  the store failed — both acceptable, both documented at `images::fetch_and_store`.

## Frontend design (binding)
- **All frontend work follows the `frontend-design` skill** (invoke it before UI tasks) and the
  visual direction doc: `docs/superpowers/specs/2026-08-04-visual-design-direction.md`.
  Implementers execute that direction (palette, type, mana line, filter chips) — they do not
  invent their own. Mana/set symbols come from the bundled `mana-font`/`keyrune` npm packages,
  never a CDN.
- Global actions (Refresh, sync status, future settings) live in the top ribbon, not in views.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index.** An
  inner dismissible layer (popup, listbox, menu) listens on `window` in the **capture**
  phase and calls `preventDefault()`; an outer one (the card detail pane) listens in the
  bubble phase and returns early on `e.defaultPrevented`. Capture is load-bearing: two
  `window` listeners for one event run in *registration* order, and the outer layer was
  mounted first, so in the bubble phase it would act before the popup and read
  `defaultPrevented` as false. Every new dismissible layer follows this or it will close
  something it did not open. Pinned by `App.test.tsx`'s Escape-stack test.
- A layer that Escape dismissed hands focus back to whatever opened it, *before* React
  flushes the close (the element is still mounted). An outside-click deliberately does not
  — the reader is already somewhere else.

## Architecture (read the spec first)
- Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`
- Research (live-verified facts, incl. Scryfall breaking changes): `docs/superpowers/research/`
- Plans: `docs/superpowers/plans/` — execute in order, check off steps as you go.
- **Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache). **TS owns domain
  logic** (deck validation, import/export parsing). Keep that boundary.

## Hard rules — database
- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with
  `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign
  key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang`
  (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE`
  deletes the user's collection on the next refresh. Orphans are *flagged*, never deleted.
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with
  its indexes and replays only that list.
- `CARDS_COLUMNS` is **frozen**: it is what schema v1 created, not what `cards` is now.
  Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE`. (`create_staging`
  derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically.)
- **`raw` is a gzip BLOB from schema v3 on, and a bare `json_extract(raw, …)` is a hard
  error, not a NULL.** SQLite reads a BLOB argument to `json_extract`/`json_type`/
  `json_each` as JSONB; a gzip member is not valid JSONB, so the call raises
  `malformed JSON` and fails the whole migration for every user who has synced since v3.
  Any migration reading `raw` goes through **`schema::json_raw`** (Rust reads use
  `card_row::raw_json` with `CAST(raw AS BLOB)`). The guard must sit **inside** the
  expression, wrapping the *argument* — never as a `WHERE` term, because the planner
  orders `WHERE` terms as it likes and evaluating the unguarded one *is* the error. This
  is invisible to tests: fixture databases hold text `raw`, so an unguarded `if v < 4`
  passes every test and breaks only in the field. v2 and v3 are both guarded; the ladder
  is walked over a gzip row by
  `schema::tests::the_v3_backfill_steps_over_a_row_whose_raw_is_not_json`.
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the
  ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` **if it touches
  an indexed column (`name`/`type_line`/`search_text`) or renumbers rowids** — and `VACUUM`
  does the latter, so it always needs one. A migration that only adds and fills unindexed
  columns does not (schema v2; `the_v2_backfill_leaves_the_search_index_answering` is the
  proof).
- Two connections: `AppState.db` writes, `AppState.db_read` is `SQLITE_OPEN_READ_ONLY`.
  Reads go through `db_read` so a search is not stuck behind an ~80 s ingest.
- `db::open` sets `PRAGMA auto_vacuum=INCREMENTAL` **before** `journal_mode=WAL` — after WAL
  has materialised the file the pragma is a silent no-op that only a `VACUUM` can apply.
  Databases from Plans 1–2 are converted once, after a sync, by `maintenance` (`compacting`
  phase); a `VACUUM` **always** needs `schema::create_fts` after it.
- Only `schema::migrate` may stop a launch. `prepare_database`'s other two steps (an FTS
  rebuild an interrupted compaction owed; the staging table an interrupted ingest left)
  are logged and left owing — their likeliest cause is a full or read-only disk, and
  `init_state` turns any error into "move `mtg.db` aside", which that disk cannot do.

## Hard rules — user data
- `collection_entries`/`wishlist_entries`/`card_migrations` reference `cards.id` **softly**
  and denormalize `set_code`/`collector_number`/`lang` (and `name`, on the wishlist). A row
  whose card vanishes is **flagged** (`needs_review`, a sentence) and never deleted —
  `reconcile::sweep_orphans` runs after every ingest and clears the flag if the card returns.
- Grain: `(card_id, finish, condition, lang, altered, signed, proxy, misprint, serial, grading)`,
  as `schema::COLLECTION_GRAIN` — one constant, because the UNIQUE index and every
  `ON CONFLICT` target must match verbatim. The `coalesce(…, '')`s are load-bearing: NULLs in
  a UNIQUE index are distinct. `grading` enters identity as **raw text**, so it is only ever
  written through the one fixed-field struct that owns its key order.
- **Quantity 0 keeps the collection row** — the condition, purchase price, tags and
  acquisition story survive the day the user owns none of the card. Deleting is
  `remove_entry` and only ever `remove_entry`. The wishlist is the opposite by table CHECK
  (`quantity > 0`): a wish for none of something is not a wish, so zero removes it. Both
  refuse a negative through the one `collection::valid_quantity`.
- Finish is an **enum** (`nonfoil|foil|etched`), condition is one of `NM|LP|MP|HP|DMG`; both
  are CHECK-constrained in SQL *and* validated in Rust, and the imported string is kept in
  `condition_original`.
- **A finish's price is a lookup in the `prices` blob** (`usd`/`usd_foil`/`usd_etched`;
  `eur_etched` does not exist, so etched is unpriced in EUR). `cards.price_usd` is a
  sort/display fallback chain and must never be summed. `tix` is never summed with fiat.
- **Wishlist fulfillment is finish-aware.** A foil wish is not filled by a nonfoil copy; a
  wish naming no finish is filled by any. `wishlist::OWNED_SQL` sums `quantity`, so a
  collection row stepped to zero contributes nothing.
- `needs_review` is a **sentence, not a flag** — the reconciler writes what happened, and
  the first message wins (a later sweep does not overwrite one). Non-NULL means "listed,
  counted, and asking to be looked at", never "hidden".
- Writes take `AppState.db` through `db::lock_for(…, WRITE_LOCK_WAIT)` and answer
  `collection::BUSY` if they cannot — reads go through `db_read` like everything else.
- `cards.oracle_id` is NULLABLE and **no live row is null** — 0 of 116,590, all 81
  reversible printings included, because `card_row` falls back to `card_faces[0]`. Every
  `oracleId === null` branch in the app is a fence around the type, not a card you can find.

## Hard rules
- Scryfall bulk data is gzipped **JSONL** (one object/line). Old JSON-array endpoints 404.
- Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- `cards.oracle_id/cmc/type_line` are NULLABLE. `collector_number` is TEXT. Prices are
  decimal strings. `legalities` is JSON (23 keys, grows). Finishes: enum, never boolean.
- npm `xlsx` is banned (CVEs). TypeScript stays on 6.0.x until TS 7.1.
- shadcn components: always `npx shadcn@latest add <x>` with Radix base (components.json).
  The app palette maps `accent` to a **text** colour (gold), so rewrite a vendored
  component's `bg-accent` surfaces to `bg-surface`. `bg-muted` needs no rewrite any more:
  the app's dim text is `--color-dim` and `--color-muted` is the surface shadcn means by it
  (it used to be the dim text, which gave a stock `TabsList` invisible labels).
  `text-muted-foreground` and `text-accent-foreground` already resolve correctly.
- **Dim text is `text-dim`, never `text-muted`** — the latter still compiles and now paints
  text in the surface colour, i.e. very nearly invisible. `src/lib/tokens.test.ts` guards it.
- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where
  the origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere.
  Variants are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never
  fetched. The handler reads through `db_read`, never the write connection. `app.security.csp`
  is not `null` any more — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
- Work on `main`, commit small after each task/step with `feat:`/`fix:`/`chore:`/`test:`.
- Tests: cover logic that can break (parsers, validation, sync). No ceremony tests.

## Working style (user preferences)
- Ultracode/dynamic workflows for large parallelizable work; subagents use Opus 5.
- Superpowers flow: brainstorm → spec → plan → subagent-driven implementation.
