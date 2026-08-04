# Plan 2/6: Images & Card Browsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Card art everywhere it belongs — a locked-down CSP, a `mtgimg://` custom protocol backed by a permanent on-disk WEBP cache, an art-grid view on the search page, and a card detail pane with face flipping, every printing of the oracle card, per-finish prices and legality chips.

**Architecture:** A v2 migration adds `image_uris`/`face_image_uris` to `cards` (backfilled from the existing `raw` JSON, no re-download) plus an `image_cache` bookkeeping table. A new Rust `images` module resolves a `(card, face, variant)` triple to a Scryfall URI through the **read-only** connection, serves it from `data/images/<variant>/<id[0..2]>/<id>-<face>.webp`, and fetches on miss from `cards.scryfall.io` via the existing `scryfall::Client`. Tauri's asynchronous URI-scheme protocol exposes that to the renderer as `mtgimg://`, so React only ever holds URLs. Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md` §5 (plus §3/§4 context). Carryover: `docs/superpowers/notes/plan-1-carryover.md`.

**Tech Stack:** Tauri 2.11.5, React 19, TypeScript 6.0.x, Vite 7, Tailwind CSS v4, TanStack Query 5, @tanstack/react-virtual 3, zustand 5, rusqlite 0.40 (bundled, FTS5), reqwest 0.12 (rustls, stream), tokio 1 (fs/io-util/rt/sync/time), tauri-plugin-single-instance 2, serde_json, Vitest 4, httpmock 0.8.

## Global Constraints

Binding values, copied verbatim from the sources that own them. Do not paraphrase them into code.

**CLAUDE.md database invariants** (all still in force — this plan adds a table and two columns and breaks none of them):

- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with `foreign_keys=ON`). User tables reference `cards.id` **without an enforced foreign key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang` (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE` deletes the user's collection on the next refresh. Orphans are *flagged*, never deleted. **`image_cache` obeys this: `card_id TEXT NOT NULL` with no `REFERENCES` clause.**
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with its indexes and replays only that list. **The image columns are not indexed, so `CARDS_INDEXES` is untouched by this plan.**
- `CARDS_COLUMNS` is **frozen**: it is what schema v1 created, not what `cards` is now. Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE`. (`create_staging` derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically.) **Task 2 adds `if v < 2` and does not touch `CARDS_COLUMNS`.**
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` — and so does `VACUUM`, which may renumber the rowids the index is keyed on. **The v2 backfill writes only new, unindexed columns and changes no rowid, so it does not rebuild; Task 2 ships a test that proves FTS still answers afterwards.**
- Two connections: `AppState.db` writes, `AppState.db_read` is `SQLITE_OPEN_READ_ONLY`. Reads go through `db_read` so a search is not stuck behind a 44 s ingest. **The image protocol reads through `db_read`. NEVER the write connection.**

**CSP** — `csp: null` ships nothing. The value that must land in `src-tauri/tauri.conf.json` (Task 1), verbatim:

```
default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: mtgimg: http://mtgimg.localhost; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'
```

- `ipc: http://ipc.localhost` is **mandatory** — Tauri 2's `invoke` is a `fetch()` at `convertFileSrc(cmd, 'ipc')` (`tauri-2.11.5/scripts/ipc-protocol.js:37`), which on Windows is `http://ipc.localhost/<cmd>`. Omit it and every command in the app fails.
- `mtgimg: http://mtgimg.localhost` — custom protocols resolve to `<scheme>://localhost/<path>` on macOS/iOS/Linux and `http://<scheme>.localhost/<path>` on Windows/Android. Both forms are listed because the same config ships everywhere.
- `style-src-attr 'unsafe-inline'` is **load-bearing**: `SearchPage.tsx` positions every virtualized row with `style={{ height, transform }}`, and inline style *attributes* fall back to `style-src` unless `style-src-attr` is present. Tauri injects hashes into `style-src` at build time, and a hash source disables `'unsafe-inline'` in that directive — so the attribute directive has to carry it separately.
- No `*` sources, ever. There is a test for that.

**User-Agent** — every `api.scryfall.com` request sends this exact string (`scryfall::USER_AGENT`, already in the source; images ride the same client so they carry it too):

```
MTGCollectionTracker/0.1 (https://github.com/markusseerup/mtg-collection)
```

and `Accept: application/json;q=0.9,*/*;q=0.8` on API calls. 403 without them.

**Rate limits** — `*.scryfall.io` (bulk + images) is explicitly **unlimited**; `api.scryfall.com` is 10/s general. Keep image fetching **≤10/s sustained anyway** (spec §4). On **429 back off 30 s** — Scryfall: *"Recieving an HTTP 429 response will result in your access being limited for 30 seconds… It is not acceptable to ignore HTTP 429 responses."*

**Image variants — WEBP only.** The four keys this app ever stores or serves, with their documented dimensions:

| variant | dimensions | ~size | used for |
|---|---|---|---|
| `thumb` | 146 × 204 | 9 KB | list rows |
| `grid` | 488 × 680 | 62 KB | card grids |
| `display` | 672 × 936 | 93 KB | detail / preview |
| `art` | 626 × 457 | 58 KB | deck covers (Plan 6) |

`small`/`normal`/`large`/`png`/`art_crop`/`border_crop`/`crop` are **never** stored — the JPG family is on a documented deprecation path and `png` is 161 GB at full library. `Variant::parse` rejects them.

**Artist credit (Scryfall policy, binding):** *"When using the `art_crop`, list the artist name and copyright elsewhere in the same interface presenting the art crop, or use the full card image elsewhere in the same interface."* The search art-grid renders **full card images** (`grid`/`thumb`), which carry the printed artist name, so it complies by construction. The card detail pane renders `display` **and** must print `artist` plus the line `Card images © Wizards of the Coast · Data © Scryfall` (spec §10 wording). Any future `art`-variant surface inherits the same requirement. Never distort, skew, blur, desaturate, recolor or watermark a card image, and never crop off the copyright or artist name.

**Frontend design — binding.** Every UI task in this plan opens by invoking the **`frontend-design` skill**, and `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is a specification, not a mood board: implementers **execute** its palette, type roles, mana line, ribbon layout and filter specs, and spend their judgment on detail quality (spacing, focus states, contrast) rather than on the direction. CLAUDE.md carries the same rule. Concretely:

- **Colour appears only where it carries Magic meaning** — mana, colour identity, rarity, card art. Chrome stays quiet: no gradients, no glows, no five-colour anything except the one signature.
- **The mana line** (2px W→U→B→R→G under the global ribbon) is that signature. It is never repeated elsewhere, and it is the app's **only** progress bar — during a sync it fills left→right behind a gold cap.
- **The global ribbon owns global actions.** Refresh, sync status and future settings live in a 48px `bg-surface` row, never in a view. Filters live with their view.
- **Type roles:** Cinzel (`@fontsource/cinzel`, 500/600) for view titles, hero copy and section headers **only**, never body text and **never below 18px**; Geist for everything else; Geist Mono for collector numbers, prices and counts.
- **Symbol fonts are bundled, never a CDN**: `mana-font` (mana symbols) and `keyrune` (set symbols) are npm packages imported through Vite. The CSP has no remote source, and adding one to load a font would be a violation of both this rule and Task 1's test.
- **Motion budget:** 150 ms ease on chip/nav state, the sync sweep on the mana line, nothing else. Every animation respects `prefers-reduced-motion`.
- **Quality floor, unannounced:** visible gold focus ring on every interactive element, AA contrast on all text, works down to 1024px width. Copy is sentence case with verbs on buttons ("Refresh data", "Reset all").

**Prices:** decimal **strings** in the `prices` JSON blob, 6 keys (`usd, usd_foil, usd_etched, eur, eur_foil, tix` — `eur_etched` does not exist in the data). Per-finish valuation reads the blob by finish (`nonfoil→usd`, `foil→usd_foil`, `etched→usd_etched`). **`price_usd` is a display/sort fallback chain and must not be used for a finish price.** `tix` is never summed with fiat. Prices are always labelled with an as-of date.

**Process:** all work on `main`, one commit per task, message style `feat:`/`fix:`/`chore:`/`test:`, with the trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

**`npm run verify` must be green before every commit** (build + lint + Vitest + `cargo test`). `npm run lint` runs with `--max-warnings 0`.

## File Structure

```
mtg-collection/
├── CLAUDE.md                                   # M: narrow the FTS-rebuild rule; add mtgimg/CSP note (T7)
├── package.json                                # M: cinzel, geist-mono, mana-font, keyrune (T8)
├── src-tauri/
│   ├── Cargo.toml                              # M: tauri-plugin-single-instance, tokio sync/time (T1, T5)
│   ├── tauri.conf.json                         # M: csp + devCsp (T1)
│   └── src/
│       ├── lib.rs                              # M: single-instance plugin, mtgimg protocol, AppState.images,
│       │                                       #    bounded exit checkpoint, new command registrations
│       ├── db.rs                               # M: lock_for() — bounded try-lock shared by images + exit (T5)
│       ├── schema.rs                           # M: migrate v2 (image columns, image_cache, backfill) (T2)
│       ├── card_row.rs                         # M: image_uris / face_image_uris fields + webp_uris() (T3)
│       ├── ingest.rs                           # M: 39-param insert (T3)
│       ├── scryfall.rs                         # M: fetch_image, RateLimited{retry_after_secs}, NotFound,
│       │                                       #    sets page cap (T4)
│       ├── sync.rs                             # M: AppState.images, status via db_read, lock_conn (T6, T7)
│       ├── search.rs                           # M: doc drift (T7); sets[]/manaValues[] filters +
│       │                                       #    SetSummary + list_sets command (T9)
│       ├── images.rs                           # NEW: variants, cache paths, URI resolution, fetch+store,
│       │                                       #      placeholders, request parsing, serve() (T5, T6, T14)
│       ├── card.rs                             # NEW: card_detail + card_printings commands (T12)
│       └── tests/fixtures/cards_sample.jsonl   # M: image_uris on the fixture lines (T3)
├── src/
│   ├── index.css                               # M: font imports + mana/pie/rarity tokens, sweep keyframes (T8)
│   ├── App.tsx                                 # M: mount the card detail pane (T13)
│   ├── lib/ipc.ts                              # M: CardDetail/Printing/SetSummary DTOs, 4 new commands,
│   │                                           #    sets[]/manaValues[] on SearchRequest (T7, T9, T10, T12)
│   ├── lib/mana.ts + .test.ts                  # NEW: WUBRG keys, mana-font classes, the line gradient,
│   │                                           #      manaLineSync (T8)
│   ├── lib/rarity.ts + .test.ts                # NEW: rarity gem colours (T8)
│   ├── lib/keyrune.ts + .test.ts               # NEW: set-symbol class from a set code (T10)
│   ├── lib/useSyncProgress.ts                  # NEW: PHASE_LABEL + the sync:progress listener, moved out
│   │                                           #      of SyncProgress so ribbon and overlay share one (T8)
│   ├── lib/images.ts + .test.ts                # NEW: mtgimg URL builder, variants, aspect ratio (T11)
│   ├── lib/store.ts                            # M: searchView (T11) + selectedCardId (T13)
│   ├── lib/useSync.ts                          # M: mergeStatus carries lastIngestSkipped (T7)
│   ├── components/Ribbon.tsx + .test.tsx        # NEW: the 48px global row — app mark, view title,
│   │                                           #      sync status, Refresh data (T8)
│   ├── components/ManaLine.tsx + .test.tsx      # NEW: the signature rule, and the app's only
│   │                                           #      progress bar (T8)
│   ├── components/AppShell.tsx + .test.tsx      # M: header removed, ribbon mounted, gold sidebar
│   │                                           #    indicator; nav assertions de-ambiguated (T8)
│   ├── components/SyncProgress.tsx + .test.tsx  # M: reduced to the first-run overlay — the mana line
│   │                                           #    is now the app's only in-place progress bar (T8)
│   ├── features/search/FilterBar.tsx + .test    # NEW: mana chips, mana-value chips, format, Reset all (T10)
│   ├── features/search/SetCombobox.tsx + .test  # NEW: searchable multi-select over `sets` (T10)
│   ├── features/search/useCardSearch.ts        # M: sets/manaValues state, toggleIn, activeFilterCount,
│   │                                           #    resetAll (T10)
│   ├── features/search/useCardSearch.test.ts   # NEW: the new pure filter helpers (T10)
│   ├── features/search/SearchPage.tsx          # M: FilterBar swap (T10); view toggle, grid branch,
│   │                                           #    prefetch (T11, T14)
│   ├── features/search/CardGrid.tsx + .test     # NEW: virtualized 5:7 art tiles with rarity gems (T11)
│   ├── features/card/CardDetailPane.tsx +.test  # NEW: faces, flip, printings, legality chips, credit (T13)
│   └── features/card/printings.ts + .test.ts    # NEW: illustration grouping, finish prices,
│                                               #      legality chips, faceCount (T13)
└── docs/superpowers/plans/2026-08-04-02-images-card-browsing.md   # this file
```

Later plans build on: `images.rs` (pre-warm job, deck covers), `card.rs` (collection badges on printings), `src/lib/images.ts` (every view that shows a card), `src/lib/mana.ts` + `src/lib/rarity.ts` (every view that shows a colour, a cost or a rarity), and `Ribbon.tsx` (settings, import/export and every future global action).

---

### Task 1: Tighten the CSP and add the single-instance guard

`csp: null` has been ledgered since Plan 1 Task 1 and must land **before** the image protocol, not after — a protocol shipped under a null CSP is a protocol nobody ever has to justify. The single-instance guard is the other prerequisite: two processes already shared one `mtg.db` and one temp `.gz`, and an image cache widens that to a shared directory tree.

**Files:**
- Modify: `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `tauri::Manager` (already imported in `lib.rs`), the existing `tauri::Builder` chain in `lib.rs::run()`.
- Produces: a non-null `app.security.csp` and `app.security.devCsp`; a single-instance plugin registered **first** in the builder; `lib.rs::focus_existing_window(app: &tauri::AppHandle)`.

- [ ] **Step 1: Write the failing CSP test** — append to the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/lib.rs`:

```rust
    /// The CSP is configuration, not code, so nothing else can fail when it is loosened.
    /// This is the guard: it reads the shipped config and pins the sources the app
    /// genuinely needs — Tauri's IPC transport, which is a `fetch` to
    /// `http://ipc.localhost` on Windows, and the image protocol — while refusing any
    /// wildcard. `style-src-attr` is here because the virtualised result list positions
    /// every row with an inline `style` attribute, and a hash injected into `style-src`
    /// at build time is what would otherwise silently disable `'unsafe-inline'` for it.
    #[test]
    fn the_shipped_csp_allows_ipc_and_images_and_nothing_wild() {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let security = &conf["app"]["security"];
        let csp = security["csp"]
            .as_str()
            .expect("app.security.csp must not be null");
        for required in [
            "default-src 'self'",
            "ipc:",
            "http://ipc.localhost",
            "mtgimg:",
            "http://mtgimg.localhost",
            "style-src-attr 'unsafe-inline'",
            "object-src 'none'",
        ] {
            assert!(csp.contains(required), "CSP is missing `{required}`: {csp}");
        }
        assert!(!csp.contains('*'), "no wildcard sources belong in the CSP: {csp}");

        // Dev has to reach Vite's HMR socket, which production must not carry.
        let dev = security["devCsp"]
            .as_str()
            .expect("app.security.devCsp must be set");
        assert!(dev.contains("ws://localhost:1420"), "{dev}");
        assert!(!csp.contains("localhost:1420"), "dev-only sources leaked into csp: {csp}");
    }
```

- [ ] **Step 2: Run it and watch it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml the_shipped_csp
```
Expected: `panicked at 'app.security.csp must not be null'`.

- [ ] **Step 3: Set the CSP** — replace the `security` block in `src-tauri/tauri.conf.json`:

```json
    "security": {
      "csp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost; img-src 'self' data: mtgimg: http://mtgimg.localhost; style-src 'self'; style-src-attr 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'",
      "devCsp": "default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ws://localhost:1420 http://localhost:1420; img-src 'self' data: mtgimg: http://mtgimg.localhost; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; font-src 'self' data:; script-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'"
    }
```

- [ ] **Step 4: Run the test again**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml the_shipped_csp
```
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Add the single-instance plugin** — in `src-tauri/Cargo.toml`, under `[dependencies]`, after `tauri-plugin-opener = "2"`:

```toml
tauri-plugin-single-instance = "2"
```

- [ ] **Step 6: Register it first** — in `src-tauri/src/lib.rs`, change the builder chain in `run()`. The plugin **must be the first one registered** (its own docs are explicit); a later registration lets the second process get far enough to open the database.

```rust
    tauri::Builder::default()
        // First, before every other plugin: this one has to decide whether the process
        // lives at all, and by the time another plugin has initialised, a second instance
        // has already opened `mtg.db` and the image cache directory that the first one
        // owns. Two processes sharing a WAL database is survivable; two sharing the temp
        // `.gz` an ingest streams from is not.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_existing_window(app);
        }))
        .plugin(tauri_plugin_opener::init())
```

and add above `run()`:

```rust
/// Bring the running instance forward when a second launch is refused.
///
/// Without this, double-clicking the exe a second time looks like nothing happened —
/// the guard is silent by design, so the app has to answer with the window itself.
fn focus_existing_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}
```

- [ ] **Step 7: Verify**

```powershell
npm run verify
```
Expected: build, lint, Vitest and `cargo test` all green.

- [ ] **Step 8: Manual smoke — the CSP is only real in a running window**

```powershell
npm run tauri dev
```
Expected, with the WebView2 devtools console open (right-click → Inspect):
- **zero** `Refused to …` CSP violation messages;
- the search box returns results (proves `connect-src ipc:` is right — a broken IPC shows as every query failing);
- **the result rows are positioned, not stacked at the top** (proves `style-src-attr`; a violation here collapses the virtualised list into one pile);
- launching the exe a second time (`src-tauri/target/debug/mtg-collection-tracker.exe`) focuses the first window instead of opening a second.

- [ ] **Step 9: Commit**

```powershell
git add -A
git commit -m "feat: lock down the CSP and refuse second instances

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema v2 — image columns, image_cache, backfill from `raw`

112,324 printings carry their image URIs only inside the `raw` JSON, 4,082 only inside `faces`, and **162 have none at all**. This adds real columns for the four WEBP variants and backfills them with `json_extract` — no re-download, no second sync.

**Files:**
- Modify: `src-tauri/src/schema.rs` (new `if v < 2` step, tests)

**Interfaces:**
- Consumes: `migrate(conn: &Connection) -> rusqlite::Result<()>`, `create_staging`, `swap_staging`, the frozen `CARDS_COLUMNS`, `CARDS_INDEXES` — all unchanged in shape.
- Produces, at `PRAGMA user_version = 2`:
  - `cards.image_uris TEXT` — compact JSON of the top-level `image_uris`, restricted to `thumb`/`grid`/`display`/`art`. NULL when the printing has no top-level image object (3.7% of cards).
  - `cards.face_image_uris TEXT` — compact JSON **array**, one entry per `card_faces[i]`: the same four-key object, or `null` for a face with no images. NULL when no face has any.
  - `image_cache(card_id, face, variant) → source_uri, bytes, fetched_at` — `WITHOUT ROWID`, **no FK to `cards.id`**.
- Not produced: any new index on `cards`, any FTS rebuild.

- [ ] **Step 1: Write the failing tests** — add to `schema.rs`'s `mod tests`:

```rust
    /// A database that stopped at version 1 — what every machine that ran Plan 1 has on
    /// disk. Built from the frozen v1 constant rather than by calling `migrate`, because
    /// `migrate` now runs straight through to 2 and there is no way back.
    fn v1_database() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE cards ({CARDS_COLUMNS});
             {indexes}
             CREATE TABLE sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;",
            indexes = cards_indexes_sql()
        ))
        .unwrap();
        create_fts(&conn).unwrap();
        conn
    }

    fn insert_raw(conn: &Connection, id: &str, name: &str, raw: &str) {
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, search_text, raw)
             VALUES (?1, ?2, 'tst', '1', 'en', 'normal', ?2, ?3)",
            rusqlite::params![id, name, raw],
        )
        .unwrap();
    }

    #[test]
    fn migrate_reaches_version_2_and_adds_the_image_columns() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        migrate(&conn).unwrap(); // still idempotent

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, 2);

        let columns: Vec<String> = table_info(&conn, "cards")
            .into_iter()
            .map(|(name, ..)| name)
            .collect();
        assert!(columns.contains(&"image_uris".to_owned()), "{columns:?}");
        assert!(columns.contains(&"face_image_uris".to_owned()), "{columns:?}");

        let cache: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE name='image_cache'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cache, 1);
    }

    /// The whole point of the step: 112 324 printings already on disk carry their image
    /// URIs only inside `raw`, and re-downloading 77 MB to recover something already
    /// stored would be absurd. The backfill reads them back out with `json_extract`.
    #[test]
    fn the_v2_step_backfills_image_uris_out_of_raw() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "top",
            "Lightning Bolt",
            r#"{"object":"card","image_uris":{"small":"s.jpg","normal":"n.jpg","thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","png":"p.png"}}"#,
        );
        insert_raw(
            &conn,
            "dfc",
            "Delver of Secrets",
            r#"{"object":"card","card_faces":[{"name":"Delver","image_uris":{"thumb":"f0t.webp","grid":"f0g.webp","display":"f0d.webp","art":"f0a.webp"}},{"name":"Aberration","image_uris":{"thumb":"f1t.webp","grid":"f1g.webp","display":"f1d.webp","art":"f1a.webp"}}]}"#,
        );
        insert_raw(&conn, "none", "No Art At All", r#"{"object":"card"}"#);

        migrate(&conn).unwrap();

        let top: String = conn
            .query_row("SELECT image_uris FROM cards WHERE id='top'", [], |r| r.get(0))
            .unwrap();
        let top: serde_json::Value = serde_json::from_str(&top).unwrap();
        assert_eq!(top["grid"], "g.webp");
        assert_eq!(top["art"], "a.webp");
        // WEBP only: the deprecated JPG/PNG family is never stored.
        assert!(top.get("normal").is_none(), "{top}");
        assert!(top.get("png").is_none(), "{top}");

        let face: String = conn
            .query_row("SELECT face_image_uris FROM cards WHERE id='dfc'", [], |r| r.get(0))
            .unwrap();
        let face: serde_json::Value = serde_json::from_str(&face).unwrap();
        assert_eq!(face[0]["display"], "f0d.webp");
        assert_eq!(face[1]["display"], "f1d.webp");
        let top_of_dfc: Option<String> = conn
            .query_row("SELECT image_uris FROM cards WHERE id='dfc'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(top_of_dfc, None, "a transform has no top-level image object");

        // The 162 printings with no images anywhere: both columns stay NULL, which is what
        // the placeholder path keys on.
        let (u, f): (Option<String>, Option<String>) = conn
            .query_row(
                "SELECT image_uris, face_image_uris FROM cards WHERE id='none'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((u, f), (None, None));
    }

    /// `cards_fts` is external-content with no triggers, so CLAUDE.md requires a rebuild
    /// after writes to `cards` outside the ingest. The v2 backfill writes only new,
    /// unindexed columns and renumbers no rowid, so it deliberately does not rebuild —
    /// and this is the evidence that the index is still intact afterwards.
    #[test]
    fn the_v2_backfill_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "bolt",
            "Lightning Bolt",
            r#"{"object":"card","image_uris":{"grid":"g.webp"}}"#,
        );
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();

        migrate(&conn).unwrap();

        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 1, "the FTS index must survive the v2 backfill");
    }

    /// Staging derives its layout from the live table, so the columns a later migration
    /// adds have to survive a sync without anyone editing `create_staging`. This is that
    /// promise, checked against the columns this plan actually adds.
    #[test]
    fn the_image_columns_survive_a_staging_swap() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging
                (id, name, set_code, collector_number, lang, layout, raw, image_uris)
             VALUES ('new','Lightning Bolt','lea','161','en','normal','{}','{\"grid\":\"g.webp\"}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let uris: String = conn
            .query_row("SELECT image_uris FROM cards WHERE id='new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(uris, "{\"grid\":\"g.webp\"}");
    }

    /// `image_cache` is not sync data and must outlive the table that is dropped on every
    /// refresh — which is exactly why it carries no foreign key to `cards.id`.
    #[test]
    fn image_cache_rows_survive_the_swap_that_drops_cards() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('bolt', 0, 'grid', 'https://cards.scryfall.io/grid/front/b/o/bolt.webp?17', 62000, 1800000000)",
            [],
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')", []).unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the image cache");

        let n: i64 = conn
            .query_row("SELECT count(*) FROM image_cache", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib schema
```
Expected: the five new tests fail (`assertion failed: version == 2`, `no such column: image_uris`, …); the five pre-existing schema tests still pass.

- [ ] **Step 3: Add the v2 step** — in `src-tauri/src/schema.rs`, add after the `if v < 1 { … }` block inside `migrate`, and add the two constants above it:

```rust
/// The image variants stored as real columns, WEBP only.
///
/// Scryfall's `image_uris` carries eleven keys; seven of them are the legacy JPG/PNG
/// family the docs mark as *replaced*, and `png` alone would be 161 GB across the
/// library. Storing four of eleven keeps the column at roughly 400 bytes a row (~47 MB
/// over 116 k printings) instead of 1.3 KB, and `raw` still holds every key that was
/// dropped, so nothing is unrecoverable.
pub const IMAGE_VARIANTS: [&str; 4] = ["thumb", "grid", "display", "art"];

/// `json_object('thumb', json_extract(<src>, '$.image_uris.thumb'), …)` for the four
/// variants. Built rather than written out so the list has one definition.
fn webp_json_object(src: &str) -> String {
    let pairs: Vec<String> = IMAGE_VARIANTS
        .iter()
        .map(|k| format!("'{k}', json_extract({src}, '$.image_uris.{k}')"))
        .collect();
    format!("json_object({})", pairs.join(", "))
}
```

```rust
    if v < 2 {
        let tx = conn.unchecked_transaction()?;
        // Two nullable columns and a table that is not `cards`, so: no entry in
        // `CARDS_INDEXES` (nothing here is indexed), no edit to `CARDS_COLUMNS` (frozen —
        // a fresh install replays v1 and then this step, exactly as an upgrade does), and
        // no FTS rebuild (the index covers name/type_line/search_text, none of which this
        // touches, and an UPDATE renumbers no rowid — `the_v2_backfill_leaves_the_search_
        // index_answering` is the evidence).
        tx.execute_batch(
            "ALTER TABLE cards ADD COLUMN image_uris TEXT;
             ALTER TABLE cards ADD COLUMN face_image_uris TEXT;
             CREATE TABLE IF NOT EXISTS image_cache (
                card_id TEXT NOT NULL,
                face INTEGER NOT NULL,
                variant TEXT NOT NULL,
                -- The exact URI the bytes on disk came from, cache-buster and all.
                -- Scryfall's `?<epoch>` equals `image_updated_at`, so a URI that no
                -- longer matches *is* the invalidation signal, with no clock to trust.
                source_uri TEXT NOT NULL,
                bytes INTEGER NOT NULL,
                fetched_at INTEGER NOT NULL,
                PRIMARY KEY (card_id, face, variant)
             ) WITHOUT ROWID;",
        )?;

        // Backfill from `raw`, which every row already carries verbatim. Restricted to
        // rows that have something to give so the UPDATE does not rewrite 116 k pages to
        // store `{"thumb":null,…}` four times over.
        tx.execute_batch(&format!(
            "UPDATE cards SET image_uris = {top}
             WHERE json_extract(raw, '$.image_uris') IS NOT NULL;",
            top = webp_json_object("raw")
        ))?;
        tx.execute_batch(&format!(
            "UPDATE cards SET face_image_uris = (
                SELECT json_group_array(json(
                    CASE WHEN json_extract(f.value, '$.image_uris') IS NULL
                         THEN 'null' ELSE {face} END))
                FROM json_each(cards.raw, '$.card_faces') f)
             WHERE json_type(raw, '$.card_faces') = 'array'
               AND EXISTS (SELECT 1 FROM json_each(cards.raw, '$.card_faces') g
                           WHERE json_extract(g.value, '$.image_uris') IS NOT NULL);",
            face = webp_json_object("f.value")
        ))?;

        tx.execute_batch("PRAGMA user_version = 2;")?;
        tx.commit()?;
    }
```

Note the `json(...)` wrapper inside `json_group_array`: SQLite drops the JSON subtype when a value passes through a `CASE`, and without it every face object would be stored as an escaped *string* rather than an object.

- [ ] **Step 4: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib schema
```
Expected: all ten schema tests pass.

- [ ] **Step 5: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: schema v2 with image columns backfilled from raw and an image_cache table

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Fill the image columns on ingest

The backfill catches the database that already exists; this catches every sync from now on. The resolution rule is spec §5 / research §4b: `image_uris` if present, else per-face.

**Files:**
- Modify: `src-tauri/src/card_row.rs`, `src-tauri/src/ingest.rs`, `src-tauri/tests/fixtures/cards_sample.jsonl`

**Interfaces:**
- Consumes: `schema::IMAGE_VARIANTS` (Task 2), `CardRow::from_json(v: &serde_json::Value) -> Option<CardRow>`.
- Produces: `CardRow.image_uris: Option<String>`, `CardRow.face_image_uris: Option<String>` — same JSON shapes the v2 backfill writes, so a backfilled row and an ingested row are indistinguishable. The `cards_staging` insert goes from 37 to **39** bound parameters.

- [ ] **Step 1: Write the failing tests** — add to `card_row.rs`'s `mod tests`:

```rust
    #[test]
    fn top_level_images_are_reduced_to_the_four_webp_variants() {
        let c = parse(r#"{"object":"card","id":"aaa","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","collector_number":"161","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"small":"s.jpg","normal":"n.jpg","large":"l.jpg","png":"p.png","art_crop":"ac.jpg","border_crop":"bc.jpg","thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","crop":"c.webp"}}"#);
        let uris: serde_json::Value = serde_json::from_str(c.image_uris.as_deref().unwrap()).unwrap();
        assert_eq!(uris["thumb"], "t.webp");
        assert_eq!(uris["grid"], "g.webp");
        assert_eq!(uris["display"], "d.webp");
        assert_eq!(uris["art"], "a.webp");
        assert_eq!(uris.as_object().unwrap().len(), 4, "WEBP only: {uris}");
        assert_eq!(c.face_image_uris, None);
    }

    /// The #1 image gotcha: transform / modal_dfc / double_faced_token / art_series /
    /// reversible_card carry no top-level `image_uris` at all, and a naive read blanks
    /// every double-faced card in the database.
    #[test]
    fn a_transform_carries_its_images_per_face() {
        let c = parse(r#"{"object":"card","id":"bbb","name":"Delver of Secrets // Insectile Aberration","lang":"en","layout":"transform","set":"isd","collector_number":"51","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Delver of Secrets","image_uris":{"thumb":"f0t.webp","grid":"f0g.webp","display":"f0d.webp","art":"f0a.webp"}},{"name":"Insectile Aberration","image_uris":{"thumb":"f1t.webp","grid":"f1g.webp","display":"f1d.webp","art":"f1a.webp"}}]}"#);
        assert_eq!(c.image_uris, None);
        let faces: serde_json::Value =
            serde_json::from_str(c.face_image_uris.as_deref().unwrap()).unwrap();
        assert_eq!(faces[0]["grid"], "f0g.webp");
        assert_eq!(faces[1]["grid"], "f1g.webp");
    }

    /// `split`, `adventure`, `flip` and `prepare` have two faces but one physical side:
    /// images live at the top level and the faces carry none. The face column must stay
    /// NULL rather than becoming `[null, null]`, because "no face images" and "faces with
    /// no images" are the same thing and only one of them is worth a row of storage.
    #[test]
    fn a_split_card_keeps_its_images_at_the_top_level() {
        let c = parse(r#"{"object":"card","id":"ccc","name":"Fire // Ice","lang":"en","layout":"split","set":"apc","collector_number":"128","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp"},"card_faces":[{"name":"Fire"},{"name":"Ice"}]}"#);
        assert!(c.image_uris.is_some());
        assert_eq!(c.face_image_uris, None);
    }

    /// 6 of 105 art_series printings in the sample had images on neither the card nor its
    /// faces, and 162 printings have none anywhere in the live data. Both columns NULL is
    /// what the placeholder path keys on, so it has to be reachable.
    #[test]
    fn a_printing_with_no_images_anywhere_leaves_both_columns_null() {
        let c = parse(r#"{"object":"card","id":"ddd","name":"Nameless Art","lang":"en","layout":"art_series","set":"sld","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Nameless Art"},{"name":"Nameless Art"}]}"#);
        assert_eq!(c.image_uris, None);
        assert_eq!(c.face_image_uris, None);
    }

    /// One face imaged, one not — art_series again. The gap has to be a JSON `null` at
    /// the right index, not a shorter array, or face 1 would resolve to face 0's art.
    #[test]
    fn a_face_without_images_is_a_null_at_its_own_index() {
        let c = parse(r#"{"object":"card","id":"eee","name":"Half Art","lang":"en","layout":"art_series","set":"sld","collector_number":"2","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Half Art"},{"name":"Half Art","image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp"}}]}"#);
        let faces: serde_json::Value =
            serde_json::from_str(c.face_image_uris.as_deref().unwrap()).unwrap();
        assert!(faces[0].is_null(), "{faces}");
        assert_eq!(faces[1]["grid"], "g.webp");
    }
```

- [ ] **Step 2: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib card_row
```
Expected: five failures, `no field `image_uris` on type `CardRow`` (a compile error is a fine red).

- [ ] **Step 3: Implement** — in `src-tauri/src/card_row.rs`, add two fields to the struct immediately after `pub image_updated_at: Option<String>,`:

```rust
    /// The four WEBP variants from the top-level `image_uris`, as compact JSON.
    /// `None` for the 3.7% of printings that have no top-level image object at all.
    pub image_uris: Option<String>,
    /// One entry per `card_faces[i]`: the same object, or JSON `null` for a face with no
    /// images. `None` when no face has any, which keeps `split`/`adventure`/`flip`
    /// (two faces, one physical side, images at the top level) out of the column.
    pub face_image_uris: Option<String>,
```

add the helper beside `compact`:

```rust
/// The four WEBP variants of an object's `image_uris`, as compact JSON.
///
/// Reduced rather than stored verbatim: Scryfall ships eleven keys, seven of them the
/// legacy JPG/PNG family its own docs mark as *replaced*. `raw` keeps the rest.
fn webp_uris(o: &Value) -> Option<Value> {
    let uris = o.get("image_uris")?.as_object()?;
    let mut out = serde_json::Map::new();
    for k in crate::schema::IMAGE_VARIANTS {
        if let Some(u) = uris.get(k).and_then(Value::as_str) {
            out.insert(k.to_owned(), Value::String(u.to_owned()));
        }
    }
    (!out.is_empty()).then(|| Value::Object(out))
}
```

and populate them in the returned `CardRow`, after `image_updated_at: s(v, "image_updated_at"),`:

```rust
            image_uris: webp_uris(v).map(|u| u.to_string()),
            // Per face index, never per card: `transform` and friends have two physical
            // sides and the URL path segment is `front`/`back` accordingly. A face with
            // no images becomes a JSON `null` in place, so index 1 never silently
            // resolves to index 0's art.
            face_image_uris: faces.and_then(|fs| {
                let per: Vec<Value> = fs
                    .iter()
                    .map(|f| webp_uris(f).unwrap_or(Value::Null))
                    .collect();
                per.iter()
                    .any(|x| !x.is_null())
                    .then(|| Value::Array(per).to_string())
            }),
```

- [ ] **Step 4: Extend the ingest insert** — in `src-tauri/src/ingest.rs`, add the two columns to the statement and the two values to `params!`:

```rust
            "INSERT INTO cards_staging (id, oracle_id, name, lang, released_at, set_code, set_name,
                collector_number, rarity, layout, mana_cost, cmc, type_line, oracle_text, colors,
                color_identity, legalities, games, finishes, prices, price_usd, price_eur, faces,
                illustration_id, frame_effects, border_color, full_art, promo, promo_types, digital,
                is_paper, edhrec_rank, game_changer, image_status, image_updated_at, image_uris,
                face_image_uris, search_text, raw)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
                ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39)",
```

and in the `params![…]` list, between `c.image_updated_at,` and `c.search_text,`:

```rust
                c.image_uris,
                c.face_image_uris,
```

- [ ] **Step 5: Add an ingest test** — in `ingest.rs`'s `mod tests`:

```rust
    /// The ingest and the v2 backfill must produce byte-identical columns, or a card's
    /// art would change shape depending on whether its row survived a sync.
    #[test]
    fn ingested_rows_carry_their_image_columns() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let p = gz_fixture(&[
            r#"{"object":"card","id":"a","name":"Bolt","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false,"image_uris":{"thumb":"t.webp","grid":"g.webp","display":"d.webp","art":"a.webp","normal":"n.jpg"}}"#,
            r#"{"object":"card","id":"b","name":"Delver","lang":"en","layout":"transform","set":"x","collector_number":"2","games":["paper"],"finishes":["nonfoil"],"digital":false,"card_faces":[{"name":"Front","image_uris":{"grid":"f0.webp"}},{"name":"Back","image_uris":{"grid":"f1.webp"}}]}"#,
        ]);

        ingest_gz(&mut conn, &p, &mut |_| {}).unwrap();

        let grid: String = conn
            .query_row(
                "SELECT json_extract(image_uris, '$.grid') FROM cards WHERE id='a'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(grid, "g.webp");
        let back: String = conn
            .query_row(
                "SELECT json_extract(face_image_uris, '$[1].grid') FROM cards WHERE id='b'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(back, "f1.webp");
    }
```

- [ ] **Step 6: Update the fixture file** — in `src-tauri/tests/fixtures/cards_sample.jsonl`, give every line a realistic image shape so the shared fixture keeps covering the gotchas: top-level `image_uris` (all eleven keys) on the `normal`/`split`/`meld` lines, `card_faces[].image_uris` on the `transform`/`reversible_card` lines, and **no image keys at all** on the `art_series` line. Use the real URL shape, e.g. `"grid": "https://cards.scryfall.io/grid/front/0/0/0000419b-0bba-4488-8f7a-6194544ce91d.webp?1783910776"`.

- [ ] **Step 7: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: all pass, including the pre-existing `ingests_fixture_and_swaps` (the fixture line count is unchanged).

- [ ] **Step 8: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: resolve and store per-face WEBP image URIs during ingest

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Scryfall client — image fetch, real 429 backoff, sets page cap

Two carryover items land here. `RateLimited` currently flattens to a bare string with no number in it, and the image fetcher is the first caller that has to *act* on a 429 rather than report it. The `/sets` pager has no page cap.

**Files:**
- Modify: `src-tauri/src/scryfall.rs`

**Interfaces:**
- Consumes: `Client { http: reqwest::Client, base_url: String }`, `Client::get_from(uri, from: Option<u64>)`, `USER_AGENT`, `ACCEPT`.
- Produces:

```rust
pub const RATE_LIMIT_BACKOFF_SECS: u64 = 30;
pub const MAX_SET_PAGES: usize = 20;

pub enum ScryfallError {
    Http(reqwest::Error),
    Io(std::io::Error),
    SizeMismatch { expected: u64, actual: u64 },
    /// CHANGED SHAPE — was a unit variant.
    RateLimited { retry_after_secs: u64 },
    /// NEW — a 404 from the file origin is permanent, not something to retry.
    NotFound,
    Unexpected(String),
}

impl Client {
    /// Bytes of one image from `cards.scryfall.io`. File origin: no `Accept`, and the
    /// origin is documented rate-limit-free — pacing lives in `images::Cache`.
    pub async fn fetch_image(&self, uri: &str) -> Result<Vec<u8>, ScryfallError>;
}
```

- Callers to update: three `429 => Err(ScryfallError::RateLimited)` sites (`check_bulk_update` line ~156, `download` line ~260, `fetch_sets` line ~295) and the test `rate_limiting_is_reported_as_its_own_error`.

- [ ] **Step 1: Write the failing tests** — add to `scryfall.rs`'s `mod tests`:

```rust
    #[tokio::test]
    async fn an_image_comes_back_as_bytes() {
        let server = MockServer::start();
        let body = vec![0x52u8, 0x49, 0x46, 0x46, 7, 7, 7, 7];
        server.mock(|when, then| {
            // The file origin needs no `Accept`, but the User-Agent is not optional
            // anywhere: "Do not allow HTTP libraries to choose the header for you."
            when.method(GET)
                .path("/grid/front/0/0/x.webp")
                .header("user-agent", USER_AGENT);
            then.status(200)
                .header("content-type", "image/webp")
                .body(body.clone());
        });
        let c = Client::new(server.base_url());

        let bytes = c
            .fetch_image(&format!("{}/grid/front/0/0/x.webp", server.base_url()))
            .await
            .unwrap();

        assert_eq!(bytes, body);
    }

    /// 404 from the CDN is permanent — a URI Scryfall gave us for an image it does not
    /// have. Retrying it forever is the failure mode this variant exists to prevent.
    #[tokio::test]
    async fn a_missing_image_is_not_a_retryable_failure() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/gone.webp");
            then.status(404);
        });
        let c = Client::new(server.base_url());

        assert!(matches!(
            c.fetch_image(&format!("{}/gone.webp", server.base_url())).await,
            Err(ScryfallError::NotFound)
        ));
    }

    /// Scryfall limits access for 30 seconds on a 429 and bans repeat offenders, so the
    /// number has to reach the caller — a bare "rate limited" marker is something a
    /// caller can only guess at. `Retry-After` is honoured when sent; 30 s is the
    /// documented floor when it is not.
    #[tokio::test]
    async fn rate_limiting_carries_the_backoff_the_caller_must_wait() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards");
            then.status(429);
        });
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(429);
        });
        server.mock(|when, then| {
            when.method(GET).path("/slow.webp");
            then.status(429).header("retry-after", "45");
        });
        let c = Client::new(server.base_url());

        assert!(matches!(
            c.check_bulk_update(None).await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 30
            })
        ));
        assert!(matches!(
            c.fetch_sets().await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 30
            })
        ));
        assert!(matches!(
            c.fetch_image(&format!("{}/slow.webp", server.base_url()))
                .await,
            Err(ScryfallError::RateLimited {
                retry_after_secs: 45
            })
        ));
    }

    /// A `next_page` chain that walks A→B→A is not a loop the `next == url` guard can
    /// see. There are ~1 050 sets across a handful of pages, so twenty is an order of
    /// magnitude of headroom and still a bound.
    #[tokio::test]
    async fn set_pagination_stops_at_the_page_cap() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/sets").query_param("page", "2");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=1", server.base_url()),
                "data": [{"code":"b","name":"B"}]}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=2", server.base_url()),
                "data": [{"code":"a","name":"A"}]}));
        });
        let c = Client::new(server.base_url());

        let sets = c.fetch_sets().await.unwrap();

        assert_eq!(sets.len(), MAX_SET_PAGES, "the cap, not an infinite loop");
    }
```

- [ ] **Step 2: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib scryfall
```
Expected: compile errors on `RateLimited { retry_after_secs }` and `fetch_image`.

- [ ] **Step 3: Delete the superseded test** — remove `rate_limiting_is_reported_as_its_own_error` in full (`scryfall.rs` ~line 639–661). `rate_limiting_carries_the_backoff_the_caller_must_wait` covers everything it did and one thing more.

- [ ] **Step 4: Reshape the error** — in `scryfall.rs`, add beside `READ_TIMEOUT`:

```rust
/// What Scryfall says a 429 costs: "your access being limited for 30 seconds". The floor
/// when the response carries no `Retry-After` of its own.
pub const RATE_LIMIT_BACKOFF_SECS: u64 = 30;

/// Pages `fetch_sets` will follow before it stops. ~1 050 sets arrive in a handful of
/// pages; a `next_page` chain that cycles A→B→A slips past the `next == url` guard and
/// would otherwise run until the process is killed.
pub const MAX_SET_PAGES: usize = 20;
```

replace the `RateLimited` variant and add `NotFound`:

```rust
    /// HTTP 429. Scryfall limits access for 30 seconds and escalates to bans, so the
    /// caller must back off — and needs the number to back off *by*, which is why this
    /// carries one instead of being a bare marker.
    #[error("rate limited by Scryfall; retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    /// HTTP 404 from a file origin: the resource is not coming, now or later. Separated
    /// from `Unexpected` so a caller can stop retrying instead of hammering a URI that
    /// will never answer.
    #[error("not found")]
    NotFound,
```

and add the helper beside `content_range_start`:

```rust
/// The backoff a 429 asks for: `Retry-After` when it is a plain seconds count, and
/// Scryfall's documented 30 s otherwise.
fn retry_after_secs(resp: &reqwest::Response) -> u64 {
    resp.headers()
        .get("retry-after")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(RATE_LIMIT_BACKOFF_SECS)
}
```

- [ ] **Step 5: Update the three call sites** — each currently reads `429 => Err(ScryfallError::RateLimited)` or `429 => return Err(ScryfallError::RateLimited)`. In all three the `resp` is still owned at that point, so:

```rust
            429 => Err(ScryfallError::RateLimited {
                retry_after_secs: retry_after_secs(&resp),
            }),
```

in `check_bulk_update`, and the `return Err(…)` form in `download` and `fetch_sets`.

- [ ] **Step 6: Cap the set pager** — in `fetch_sets`, change `loop {` to `for _ in 0..MAX_SET_PAGES {`. The `break`s inside stay exactly as they are; the `for` supplies the ceiling the `loop` lacked.

- [ ] **Step 7: Add `fetch_image`** — after `fetch_sets`, inside `impl Client`:

```rust
    /// The bytes of one card image from `cards.scryfall.io`.
    ///
    /// A file origin, not the API: no `Accept` header (the `User-Agent` pinned on the
    /// client rides along regardless), and Scryfall documents `*.scryfall.io` as having
    /// no rate limits. The ≤10/s the spec still asks for is paced by `images::Cache`,
    /// which is where the request *rate* is known — this call does exactly one fetch.
    ///
    /// Buffered, not streamed: the largest variant this app stores is ~93 KB, and a file
    /// that small does not repay the complexity streaming buys the 77 MB bulk download.
    pub async fn fetch_image(&self, uri: &str) -> Result<Vec<u8>, ScryfallError> {
        let resp = self.get_from(uri, None).await?;
        match resp.status().as_u16() {
            200 => Ok(resp.bytes().await?.to_vec()),
            404 => Err(ScryfallError::NotFound),
            429 => Err(ScryfallError::RateLimited {
                retry_after_secs: retry_after_secs(&resp),
            }),
            s => Err(ScryfallError::Unexpected(format!("status {s}"))),
        }
    }
```

- [ ] **Step 8: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib scryfall
```
Expected: every scryfall test passes, including the four new ones.

- [ ] **Step 9: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: image fetching, 429 backoff with a real duration, sets page cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: The image cache module

Everything here except the one network call is pure or filesystem-only, so it is all testable. The cache is disposable by contract (spec §8: deleting `data/images` is always safe) — `image_cache` is bookkeeping, never the source of truth.

**Files:**
- Create: `src-tauri/src/images.rs`
- Modify: `src-tauri/src/db.rs` (bounded lock helper), `src-tauri/src/lib.rs` (`pub mod images;`), `src-tauri/Cargo.toml` (tokio `sync`, `time`)

**Interfaces:**
- Consumes: `scryfall::Client::fetch_image`, `scryfall::ScryfallError::{RateLimited, NotFound}`, `schema::IMAGE_VARIANTS`, the `cards.image_uris` / `cards.face_image_uris` columns and `image_cache` (Task 2), `rusqlite::Connection`.
- Produces:

```rust
pub enum Variant { Thumb, Grid, Display, Art }
impl Variant {
    pub fn parse(s: &str) -> Option<Variant>;
    pub fn key(self) -> &'static str;              // "thumb" | "grid" | "display" | "art"
    pub fn dimensions(self) -> (u32, u32);
}
pub struct ImageKey { pub card_id: String, pub face: u8, pub variant: Variant }
pub enum Placeholder { NoImage, CardBack }
pub enum Resolution { Uri(String), Missing(Placeholder), Unknown }
pub struct Served { pub bytes: Vec<u8>, pub content_type: &'static str }
pub enum ImageError { UnknownCard, RateLimited { retry_after_secs: u64 }, Fetch(String), Io(String), Db(String) }

pub fn cache_path(images_dir: &Path, key: &ImageKey) -> PathBuf;
pub fn resolve(conn: &Connection, key: &ImageKey) -> Result<Resolution, String>;
pub fn is_current(conn: &Connection, key: &ImageKey, uri: &str) -> bool;
pub fn record(conn: &Connection, key: &ImageKey, uri: &str, bytes: usize) -> rusqlite::Result<()>;
pub fn placeholder_svg(kind: Placeholder, variant: Variant) -> String;

pub struct Cache;
impl Cache {
    pub fn new(images_dir: PathBuf) -> Cache;
    pub fn dir(&self) -> &Path;
    pub async fn get(&self, client: &scryfall::Client,
                     read: &Mutex<Connection>, write: &Mutex<Connection>,
                     key: &ImageKey) -> Result<Served, ImageError>;
}
```

and in `db.rs`:

```rust
pub fn lock_for(mutex: &Mutex<Connection>, timeout: Duration) -> Option<MutexGuard<'_, Connection>>;
```

- [ ] **Step 1: Add the tokio features** — in `src-tauri/Cargo.toml`:

```toml
tokio = { version = "1", features = ["fs", "io-util", "rt", "sync", "time"] }
```

`sync` is the semaphore that caps concurrent image fetches; `time` is the sleep the pacer and the 429 penalty are made of.

- [ ] **Step 2: Write the failing `db::lock_for` test** — add to `db.rs`'s `mod tests`:

```rust
    /// Two callers need the write lock *without* being willing to wait out a 44 s
    /// ingest: the exit checkpoint (which would park a window-less process the user
    /// believes has quit) and the image cache's bookkeeping (which would hold a picture
    /// hostage to a sync). Both have a correct answer for "could not".
    #[test]
    fn lock_for_gives_up_instead_of_waiting_out_an_ingest() {
        let mutex = std::sync::Mutex::new(Connection::open_in_memory().unwrap());

        let taken = lock_for(&mutex, Duration::from_millis(50));
        assert!(taken.is_some(), "an uncontended lock is taken immediately");

        let started = std::time::Instant::now();
        let blocked = lock_for(&mutex, Duration::from_millis(50));
        assert!(blocked.is_none(), "a held lock must not be waited out");
        assert!(
            started.elapsed() < Duration::from_millis(500),
            "giving up took {:?}",
            started.elapsed()
        );

        drop(taken);
        assert!(lock_for(&mutex, Duration::from_millis(50)).is_some());
    }
```

- [ ] **Step 3: Run it and watch it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::lock_for
```
Expected: `cannot find function 'lock_for' in this scope`.

- [ ] **Step 4: Implement `lock_for`** — in `src-tauri/src/db.rs`, extend the imports to `use std::sync::{Mutex, MutexGuard, TryLockError};` and `use std::time::{Duration, Instant};`, then add:

```rust
/// How long `lock_for` sleeps between attempts. Short enough that the wait is invisible,
/// long enough that a contended lock is not a spin.
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Take `mutex`, giving up after `timeout` rather than queueing behind whatever holds it.
///
/// The write connection is held for the whole of a 44 s ingest. Callers who cannot pay
/// that — the exit checkpoint, the image cache's bookkeeping — ask for a bound instead,
/// because for both of them "could not" is a real answer: skip the checkpoint (the WAL is
/// a valid journal either way), skip the row (one re-fetch from an unlimited origin).
///
/// Poisoning is recovered exactly as `sync::lock_db` does: the panicking thread's
/// `Connection` survives, and refusing the lock forever would brick the app for no gain.
pub fn lock_for(
    mutex: &Mutex<Connection>,
    timeout: Duration,
) -> Option<MutexGuard<'_, Connection>> {
    let deadline = Instant::now() + timeout;
    loop {
        match mutex.try_lock() {
            Ok(guard) => return Some(guard),
            Err(TryLockError::Poisoned(e)) => return Some(e.into_inner()),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return None;
                }
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
        }
    }
}
```

- [ ] **Step 5: Run it**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib db::tests::lock_for
```
Expected: `test result: ok. 1 passed`.

- [ ] **Step 6: Register the module** — in `src-tauri/src/lib.rs`, add `pub mod images;` to the module list (after `pub mod ingest;`).

- [ ] **Step 7: Write the failing images tests** — create `src-tauri/src/images.rs` containing only this test module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    /// A normal card (top-level images), a transform (per-face), and one of the 162
    /// printings that have no image anywhere.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, image_uris, raw)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d','Bolt','lea','161','en','normal',
                     json_object(
                       'thumb','https://cards.scryfall.io/thumb/front/0/0/x.webp?17',
                       'grid','https://cards.scryfall.io/grid/front/0/0/x.webp?17',
                       'display','https://cards.scryfall.io/display/front/0/0/x.webp?17',
                       'art','https://cards.scryfall.io/art/front/0/0/x.webp?17'), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, face_image_uris, raw)
             VALUES ('ab000000-0000-0000-0000-000000000001','Delver','isd','51','en','transform',
                     json_array(
                       json_object('grid','https://cards.scryfall.io/grid/front/a/b/y.webp?9'),
                       json_object('grid','https://cards.scryfall.io/grid/back/a/b/y.webp?9')), '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('cd000000-0000-0000-0000-000000000002','Nameless','sld','1','en','art_series','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn key(id: &str, face: u8, variant: Variant) -> ImageKey {
        ImageKey {
            card_id: id.to_owned(),
            face,
            variant,
        }
    }

    /// WEBP only, and the rejection is a security boundary as much as a policy one: the
    /// variant becomes a directory name, so anything that is not one of four literals
    /// must never reach the filesystem.
    #[test]
    fn only_the_four_webp_variants_are_accepted() {
        for good in ["thumb", "grid", "display", "art"] {
            assert!(Variant::parse(good).is_some(), "{good}");
        }
        for bad in [
            "png", "small", "normal", "large", "art_crop", "border_crop", "crop", "..", "",
        ] {
            assert!(Variant::parse(bad).is_none(), "{bad} must be refused");
        }
    }

    /// The layout spec §5 fixes. The two-character shard is not decoration: a full
    /// `thumb` cache is ~120 000 files, and one directory holding them is one the user's
    /// own file manager cannot open.
    #[test]
    fn the_cache_path_shards_on_the_first_two_characters() {
        let dir = Path::new("D:\\app\\data\\images");

        assert_eq!(
            cache_path(dir, &key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Grid)),
            dir.join("grid")
                .join("00")
                .join("0000419b-0bba-4488-8f7a-6194544ce91d-0.webp")
        );
        assert_eq!(
            cache_path(dir, &key("ab000000-0000-0000-0000-000000000001", 1, Variant::Thumb)),
            dir.join("thumb")
                .join("ab")
                .join("ab000000-0000-0000-0000-000000000001-1.webp")
        );
    }

    #[test]
    fn a_top_level_image_resolves_for_face_zero() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Display),
        )
        .unwrap();
        assert!(
            matches!(r, Resolution::Uri(ref u)
                     if u == "https://cards.scryfall.io/display/front/0/0/x.webp?17"),
            "{r:?}"
        );
    }

    /// The resolution rule from the other side: a transform has no top-level images and
    /// each physical side has its own.
    #[test]
    fn a_transform_resolves_per_face() {
        let conn = seeded();
        let front = resolve(
            &conn,
            &key("ab000000-0000-0000-0000-000000000001", 0, Variant::Grid),
        )
        .unwrap();
        let back = resolve(
            &conn,
            &key("ab000000-0000-0000-0000-000000000001", 1, Variant::Grid),
        )
        .unwrap();
        assert!(
            matches!(front, Resolution::Uri(ref u) if u.contains("/front/")),
            "{front:?}"
        );
        assert!(
            matches!(back, Resolution::Uri(ref u) if u.contains("/back/")),
            "{back:?}"
        );
    }

    /// Face 1 of a card with one physical side. Not an error, and emphatically not the
    /// front image — every normal Magic card has a back, and showing the front twice is
    /// how a flip animation ends up lying about the card.
    #[test]
    fn the_back_of_a_single_faced_card_is_a_card_back() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("0000419b-0bba-4488-8f7a-6194544ce91d", 1, Variant::Grid),
        )
        .unwrap();
        assert!(matches!(r, Resolution::Missing(Placeholder::CardBack)), "{r:?}");
    }

    /// 162 printings in the live data have no image anywhere. A placeholder, never a
    /// failure: there is nothing to retry and nothing the user can do.
    #[test]
    fn a_printing_with_no_art_resolves_to_a_placeholder() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("cd000000-0000-0000-0000-000000000002", 0, Variant::Grid),
        )
        .unwrap();
        assert!(matches!(r, Resolution::Missing(Placeholder::NoImage)), "{r:?}");
    }

    #[test]
    fn an_unknown_card_is_not_a_placeholder() {
        let conn = seeded();
        let r = resolve(
            &conn,
            &key("ff000000-0000-0000-0000-0000000000ff", 0, Variant::Grid),
        )
        .unwrap();
        assert!(matches!(r, Resolution::Unknown), "{r:?}");
    }

    /// The invalidation rule. Scryfall's `?<epoch>` cache-buster equals
    /// `image_updated_at`, so a stored URI that no longer matches the resolved one *is*
    /// the re-scan signal — with no clock, mtime or filesystem timestamp anywhere in the
    /// decision (a FAT32 stick rounds mtimes to two seconds).
    #[test]
    fn a_changed_image_version_invalidates_the_cached_bytes() {
        let conn = seeded();
        let k = key("0000419b-0bba-4488-8f7a-6194544ce91d", 0, Variant::Grid);
        let old = "https://cards.scryfall.io/grid/front/0/0/x.webp?17";
        let new = "https://cards.scryfall.io/grid/front/0/0/x.webp?99";

        assert!(!is_current(&conn, &k, old), "nothing is cached yet");
        record(&conn, &k, old, 62_000).unwrap();
        assert!(is_current(&conn, &k, old));
        assert!(!is_current(&conn, &k, new), "a bumped version must miss");

        record(&conn, &k, new, 62_100).unwrap();
        assert!(is_current(&conn, &k, new), "re-recording replaces the row");
    }

    #[test]
    fn placeholders_are_svg_at_the_variant_dimensions() {
        let grid = placeholder_svg(Placeholder::NoImage, Variant::Grid);
        assert!(grid.starts_with("<svg"), "{grid}");
        assert!(grid.contains("viewBox=\"0 0 488 680\""), "{grid}");
        assert!(grid.contains("No image"), "{grid}");

        // The art variant is landscape. A portrait placeholder there would be a stretched
        // frame — which for a real card image the Scryfall policy forbids outright, and
        // which for ours just looks broken.
        let art = placeholder_svg(Placeholder::CardBack, Variant::Art);
        assert!(art.contains("viewBox=\"0 0 626 457\""), "{art}");
        assert!(art.contains("Card back"), "{art}");
    }
}
```

- [ ] **Step 8: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib images
```
Expected: compile errors naming `Variant`, `ImageKey`, `Resolution`, `Placeholder`, `cache_path`, `resolve`, `is_current`, `record`, `placeholder_svg`.

- [ ] **Step 9: Write the module header** — at the top of `src-tauri/src/images.rs`, above the test module:

```rust
//! The permanent, disposable image cache and the resolution rule behind it.
//!
//! Three rules run through everything here:
//!
//! * **Per face, never per card.** 3.7% of printings carry no top-level `image_uris` at
//!   all — `transform`, `modal_dfc`, `double_faced_token`, `art_series` and
//!   `reversible_card` put them on the faces instead — so a lookup is a
//!   `(card, face, variant)` triple and the front/back distinction is physical.
//! * **The URI is the version.** Scryfall's `?<epoch>` cache-buster equals
//!   `image_updated_at`, so "are these bytes current" is a string comparison against the
//!   URI they came from. No clock, no mtime, nothing a FAT32 stick can round away.
//! * **The cache is disposable.** `image_cache` records what was fetched; deleting
//!   `data/images` is always safe and costs only re-downloads (spec §8).

use crate::scryfall::{self, ScryfallError};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

/// Concurrent fetches. `*.scryfall.io` is documented as having no rate limit, but the
/// spec still asks for ≤10/s sustained, and six ~60 KB requests in flight is comfortably
/// under that on any connection that can render the grid at all.
const MAX_CONCURRENT_FETCHES: usize = 6;

/// Minimum spacing between two fetch *starts* — the ≤10/s ceiling expressed as something
/// a scheduler can enforce.
const MIN_FETCH_INTERVAL: Duration = Duration::from_millis(100);

/// How long the bookkeeping write waits for the write connection before giving up. The
/// ingest holds it for 44 s once a day; a picture must not wait that out, and a missing
/// `image_cache` row costs one re-fetch from an origin with no rate limit.
const BOOKKEEPING_LOCK_WAIT: Duration = Duration::from_millis(250);

pub const WEBP: &str = "image/webp";
pub const SVG: &str = "image/svg+xml";
```

- [ ] **Step 10: Implement `Variant`, `ImageKey` and `cache_path`**

```rust
/// The image sizes this app stores. WEBP only — the JPG/PNG family Scryfall's own docs
/// mark as *replaced* is never fetched, and `png` alone would be 161 GB across the
/// library.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Variant {
    Thumb,
    Grid,
    Display,
    Art,
}

impl Variant {
    /// The only way a string becomes a `Variant`.
    ///
    /// A security boundary as much as a policy one: the variant becomes a directory name
    /// under the data folder, and an unvalidated segment out of a URL is how `..` reaches
    /// a filesystem. Four literals in, nothing else out.
    pub fn parse(s: &str) -> Option<Variant> {
        match s {
            "thumb" => Some(Variant::Thumb),
            "grid" => Some(Variant::Grid),
            "display" => Some(Variant::Display),
            "art" => Some(Variant::Art),
            _ => None,
        }
    }

    /// The `image_uris` key, which is also the cache directory name.
    pub fn key(self) -> &'static str {
        match self {
            Variant::Thumb => "thumb",
            Variant::Grid => "grid",
            Variant::Display => "display",
            Variant::Art => "art",
        }
    }

    /// Documented pixel dimensions, so a placeholder occupies exactly the space the real
    /// image would have.
    pub fn dimensions(self) -> (u32, u32) {
        match self {
            Variant::Thumb => (146, 204),
            Variant::Grid => (488, 680),
            Variant::Display => (672, 936),
            Variant::Art => (626, 457),
        }
    }
}

/// One cacheable image: a printing, a physical face, a size.
#[derive(Debug, Clone)]
pub struct ImageKey {
    pub card_id: String,
    /// 0 = front. A face beyond what the card physically has resolves to a card back.
    pub face: u8,
    pub variant: Variant,
}

/// `images/<variant>/<id[0..2]>/<id>-<face>.webp`, exactly as spec §5 fixes it.
pub fn cache_path(images_dir: &Path, key: &ImageKey) -> PathBuf {
    let shard: String = key.card_id.chars().take(2).collect();
    images_dir
        .join(key.variant.key())
        .join(shard)
        .join(format!("{}-{}.webp", key.card_id, key.face))
}
```

- [ ] **Step 11: Implement resolution and bookkeeping**

```rust
/// What a placeholder is standing in for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Placeholder {
    /// Scryfall has no image for this printing — 162 of them in the live data.
    NoImage,
    /// A face this card does not physically have.
    CardBack,
}

/// Where an [`ImageKey`] points.
#[derive(Debug)]
pub enum Resolution {
    Uri(String),
    Missing(Placeholder),
    /// No row with that id. Distinct from `Missing` because it is a caller error rather
    /// than a gap in Scryfall's data, and it deserves a 404 rather than a picture.
    Unknown,
}

/// Resolve a key against `cards`, applying spec §5's rule: `image_uris` if present, else
/// `card_faces[i].image_uris`.
///
/// **Read-only by contract.** Every caller passes the `db_read` connection: a card
/// picture must not queue behind a 44 s ingest, and it must never be the handle that
/// takes a write lock.
pub fn resolve(conn: &Connection, key: &ImageKey) -> Result<Resolution, String> {
    let row: Option<(Option<String>, Option<String>)> = conn
        .query_row(
            "SELECT json_extract(image_uris, '$.' || ?2),
                    json_extract(face_image_uris, '$[' || ?3 || '].' || ?2)
             FROM cards WHERE id = ?1",
            params![key.card_id, key.variant.key(), key.face as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;

    let Some((top, face)) = row else {
        return Ok(Resolution::Unknown);
    };
    // Face first for anything past the front: a transform's back exists only on the face,
    // and a `meld` card's top-level image is its front and nothing else. Falling back to
    // the top-level image for face 1 would show the front of the card on its own back.
    if let Some(uri) = face.or_else(|| (key.face == 0).then_some(top).flatten()) {
        return Ok(Resolution::Uri(uri));
    }
    Ok(Resolution::Missing(if key.face > 0 {
        Placeholder::CardBack
    } else {
        Placeholder::NoImage
    }))
}

/// Are the bytes on disk the ones `uri` names?
///
/// Compared against the URI the file was fetched from, cache-buster and all — so a
/// re-scan on Scryfall's side changes the URI and this answers false, with no timestamp
/// anywhere in the decision.
pub fn is_current(conn: &Connection, key: &ImageKey, uri: &str) -> bool {
    conn.query_row(
        "SELECT source_uri FROM image_cache WHERE card_id = ?1 AND face = ?2 AND variant = ?3",
        params![key.card_id, key.face as i64, key.variant.key()],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
    .is_some_and(|stored| stored == uri)
}

/// Record what was just written to disk. An upsert, because a re-fetch replaces a row.
pub fn record(conn: &Connection, key: &ImageKey, uri: &str, bytes: usize) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, unixepoch())
         ON CONFLICT(card_id, face, variant) DO UPDATE SET
            source_uri = excluded.source_uri,
            bytes = excluded.bytes,
            fetched_at = excluded.fetched_at",
        params![
            key.card_id,
            key.face as i64,
            key.variant.key(),
            uri,
            bytes as i64
        ],
    )?;
    Ok(())
}
```

- [ ] **Step 12: Implement the placeholders**

```rust
/// A placeholder, drawn rather than shipped.
///
/// SVG for three reasons: no binary asset and no WEBP encoder in the dependency tree, it
/// scales to whatever the tile is, and the colours can be the app's own rather than a
/// grey rectangle that reads as a broken image. It is emphatically *not* a Magic card
/// back — that artwork belongs to Wizards of the Coast, and the image policy is not a
/// thing to be clever about.
pub fn placeholder_svg(kind: Placeholder, variant: Variant) -> String {
    let (w, h) = variant.dimensions();
    let label = match kind {
        Placeholder::NoImage => "No image",
        Placeholder::CardBack => "Card back",
    };
    // Hex equivalents of --color-surface / --color-border / --color-muted, so a
    // placeholder sits in the grid instead of glowing out of it.
    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w} {h}\" width=\"{w}\" \
         height=\"{h}\" role=\"img\" aria-label=\"{label}\">\
         <rect width=\"{w}\" height=\"{h}\" rx=\"{r}\" fill=\"#2b2b31\"/>\
         <rect x=\"8\" y=\"8\" width=\"{iw}\" height=\"{ih}\" rx=\"{ir}\" fill=\"none\" \
         stroke=\"#3f3f47\" stroke-width=\"4\"/>\
         <text x=\"50%\" y=\"50%\" fill=\"#8a8a93\" font-family=\"sans-serif\" \
         font-size=\"{fs}\" text-anchor=\"middle\" dominant-baseline=\"middle\">{label}</text>\
         </svg>",
        r = h / 24,
        ir = h / 32,
        iw = w - 16,
        ih = h - 16,
        fs = h / 18,
    )
}
```

- [ ] **Step 13: Implement `Cache`**

```rust
/// What the protocol hands back.
pub struct Served {
    pub bytes: Vec<u8>,
    pub content_type: &'static str,
}

#[derive(Debug, thiserror::Error)]
pub enum ImageError {
    #[error("no card with that id")]
    UnknownCard,
    #[error("rate limited by Scryfall; retry after {retry_after_secs}s")]
    RateLimited { retry_after_secs: u64 },
    #[error("could not fetch the image: {0}")]
    Fetch(String),
    #[error("could not use the image cache: {0}")]
    Io(String),
    #[error("could not read the card database: {0}")]
    Db(String),
}

/// The on-disk image cache: lazy, permanent, paced.
pub struct Cache {
    dir: PathBuf,
    /// Caps images in flight. A grid that scrolls fast can queue hundreds of tiles.
    permits: tokio::sync::Semaphore,
    /// Serialises the *start* of each fetch so [`MIN_FETCH_INTERVAL`] is enforced, and
    /// carries the 429 penalty: Scryfall's rate limit is per application, so a limit one
    /// request earns has to be paid by every request, not just that one.
    gate: tokio::sync::Mutex<tokio::time::Instant>,
}

impl Cache {
    pub fn new(images_dir: PathBuf) -> Cache {
        Cache {
            dir: images_dir,
            permits: tokio::sync::Semaphore::new(MAX_CONCURRENT_FETCHES),
            gate: tokio::sync::Mutex::new(tokio::time::Instant::now()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Bytes for `key`: from disk when they are current, else fetched, stored and served.
    ///
    /// `read` does all the reading; `write` is taken only for the bookkeeping row, only
    /// with a bound, and not at all on a cache hit.
    pub async fn get(
        &self,
        client: &scryfall::Client,
        read: &Mutex<Connection>,
        write: &Mutex<Connection>,
        key: &ImageKey,
    ) -> Result<Served, ImageError> {
        let (uri, cached) = {
            let conn = read.lock().unwrap_or_else(|e| e.into_inner());
            match resolve(&conn, key).map_err(ImageError::Db)? {
                Resolution::Unknown => return Err(ImageError::UnknownCard),
                Resolution::Missing(kind) => {
                    return Ok(Served {
                        bytes: placeholder_svg(kind, key.variant).into_bytes(),
                        content_type: SVG,
                    })
                }
                Resolution::Uri(uri) => {
                    let current = is_current(&conn, key, &uri);
                    (uri, current)
                }
            }
        };

        let path = cache_path(&self.dir, key);
        if cached {
            // The row says these bytes are current; the *file* is the thing that can have
            // been deleted under us, and that is allowed — the cache is disposable, so a
            // missing file is a miss rather than an error.
            if let Ok(bytes) = tokio::fs::read(&path).await {
                return Ok(Served {
                    bytes,
                    content_type: WEBP,
                });
            }
        }

        let bytes = self.fetch(client, &uri).await?;
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|e| ImageError::Io(e.to_string()))?;
        }
        tokio::fs::write(&path, &bytes)
            .await
            .map_err(|e| ImageError::Io(e.to_string()))?;

        // Bookkeeping last, and optional. Losing it costs one re-fetch from an origin
        // with no rate limit; waiting for it would cost the user a picture for the length
        // of an ingest.
        if let Some(conn) = crate::db::lock_for(write, BOOKKEEPING_LOCK_WAIT) {
            let _ = record(&conn, key, &uri, bytes.len());
        }
        Ok(Served {
            bytes,
            content_type: WEBP,
        })
    }

    /// One paced fetch: a permit, then the interval gate, then the request.
    async fn fetch(&self, client: &scryfall::Client, uri: &str) -> Result<Vec<u8>, ImageError> {
        let _permit = self
            .permits
            .acquire()
            .await
            .map_err(|e| ImageError::Fetch(e.to_string()))?;
        {
            let mut next = self.gate.lock().await;
            tokio::time::sleep_until(*next).await;
            *next = tokio::time::Instant::now() + MIN_FETCH_INTERVAL;
        }

        match client.fetch_image(uri).await {
            Ok(bytes) => Ok(bytes),
            Err(ScryfallError::RateLimited { retry_after_secs }) => {
                // The penalty is per application, so it applies to everyone: push the
                // gate out so no other tile even starts until the window has passed.
                let mut next = self.gate.lock().await;
                *next = tokio::time::Instant::now() + Duration::from_secs(retry_after_secs);
                Err(ImageError::RateLimited { retry_after_secs })
            }
            // A 404 for a URI Scryfall itself published. Nothing to retry, but nothing
            // worth caching either — it is rare enough to simply report.
            Err(ScryfallError::NotFound) => Err(ImageError::Fetch("image not found".into())),
            Err(e) => Err(ImageError::Fetch(e.to_string())),
        }
    }
}
```

- [ ] **Step 14: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib images
```
Expected: the ten images tests pass.

- [ ] **Step 15: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: image cache with per-face resolution, URI-versioned invalidation, paced fetching

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: The `mtgimg://` custom protocol

Tauri 2 has no `registerSchemesAsPrivileged` — that is Electron's API. The equivalent here is `Builder::register_asynchronous_uri_scheme_protocol` plus the CSP allowance Task 1 already shipped; Tauri registers and privileges the scheme itself. **On Windows the origin is `http://mtgimg.localhost/<path>`** and on macOS/iOS/Linux it is `mtgimg://localhost/<path>` (`tauri-2.11.5/src/app.rs`, docs on `register_asynchronous_uri_scheme_protocol`), so the handler must read the *path* and never the host.

**Files:**
- Modify: `src-tauri/src/images.rs` (request parsing + `serve`), `src-tauri/src/lib.rs` (registration), `src-tauri/src/sync.rs` (`AppState.images`, `lock_conn`)

**Interfaces:**
- Consumes: `images::{Cache, ImageKey, Variant, Served, ImageError}` (Task 5), `AppState { db, db_read, data_dir, syncing, client }` (`sync.rs`), `tauri::http`.
- Produces:

```rust
// images.rs
pub fn parse_request_path(path: &str) -> Option<ImageKey>;
pub async fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>>;

// sync.rs — AppState gains one field
pub struct AppState {
    pub db: Mutex<Connection>,
    pub db_read: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub syncing: AtomicBool,
    pub client: scryfall::Client,
    pub images: images::Cache,          // NEW
}
```

- URL shape: `<origin>/<variant>/<card_id>/<face>` — e.g. `http://mtgimg.localhost/grid/0000419b-0bba-4488-8f7a-6194544ce91d/0`.
- Status codes: `200` bytes or placeholder · `404` unknown card or unparseable path · `503` + `Retry-After` on a rate limit · `502` on any other fetch failure. A retryable failure must *not* be a 200 with a placeholder body, or the UI has no way to try again.

- [ ] **Step 1: Write the failing parser tests** — add to `images.rs`'s `mod tests`:

```rust
    #[test]
    fn a_request_path_parses_into_a_key() {
        let k = parse_request_path("/grid/0000419b-0bba-4488-8f7a-6194544ce91d/0").unwrap();
        assert_eq!(k.card_id, "0000419b-0bba-4488-8f7a-6194544ce91d");
        assert_eq!(k.face, 0);
        assert_eq!(k.variant, Variant::Grid);

        // Same path with no leading slash: the two platform URL forms differ in origin,
        // not in path, but a handler that assumed one of them is a handler that breaks on
        // the other platform's first run.
        let k = parse_request_path("display/ab000000-0000-0000-0000-000000000001/1").unwrap();
        assert_eq!(k.face, 1);
        assert_eq!(k.variant, Variant::Display);
    }

    /// The path becomes a filesystem path, so everything that is not a Scryfall UUID and
    /// one of four variant names has to die here. `..` is the obvious attack; a
    /// percent-encoded separator is the one that gets missed.
    #[test]
    fn a_hostile_or_malformed_path_is_refused() {
        for bad in [
            "/grid/../../../windows/system32/config/sam/0",
            "/grid/%2e%2e%2f%2e%2e%2fsecrets/0",
            "/png/0000419b-0bba-4488-8f7a-6194544ce91d/0",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/0/extra",
            "/grid/not a uuid/0",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/nine",
            "/grid/0000419b-0bba-4488-8f7a-6194544ce91d/9",
            "",
            "/",
        ] {
            assert!(parse_request_path(bad).is_none(), "{bad} must be refused");
        }
    }
```

- [ ] **Step 2: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib images
```
Expected: `cannot find function 'parse_request_path'`.

- [ ] **Step 3: Implement the parser** — in `images.rs`, after `cache_path`:

```rust
/// Faces this app will serve. Every physical Magic card has at most two sides, and the
/// number goes into a file name — an unbounded one is an unbounded directory.
const MAX_FACE: u8 = 1;

/// `/<variant>/<card_id>/<face>` → a key, or `None`.
///
/// The path is attacker-controlled in the sense that matters — it comes out of a URL the
/// renderer builds and ends up as a filesystem path — so this validates rather than
/// sanitises: the variant must be one of four literals, the id must look like a Scryfall
/// UUID (hex and dashes, nothing else, so no separator survives in any encoding), and the
/// face must be a single digit within range. Anything else is refused, not repaired.
pub fn parse_request_path(path: &str) -> Option<ImageKey> {
    let mut parts = path.trim_start_matches('/').split('/');
    let variant = Variant::parse(parts.next()?)?;
    let card_id = parts.next()?;
    let face: u8 = parts.next()?.parse().ok()?;
    // A fourth segment means the URL is not the one this app builds, and guessing at what
    // it meant is how a path traversal gets in.
    if parts.next().is_some() {
        return None;
    }
    if face > MAX_FACE || !is_card_id(card_id) {
        return None;
    }
    Some(ImageKey {
        card_id: card_id.to_owned(),
        face,
        variant,
    })
}

/// A Scryfall id: 36 characters of lowercase hex and dashes. Deliberately a charset check
/// rather than a UUID parse — the point is that no `/`, `\`, `.` or `%` can survive it,
/// which is a stronger and simpler claim than "is well-formed".
fn is_card_id(s: &str) -> bool {
    s.len() == 36
        && s.chars()
            .all(|c| c.is_ascii_hexdigit() || c == '-')
}
```

- [ ] **Step 4: Run the parser tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib images
```
Expected: all twelve images tests pass.

- [ ] **Step 5: Give `AppState` the cache** — in `src-tauri/src/sync.rs`, add the field and the shared read-lock helper:

```rust
    pub client: scryfall::Client,
    /// The image cache. Lives here so the protocol handler can reach it from an
    /// `AppHandle` — it is the only state the handler has.
    pub images: crate::images::Cache,
```

and beside `lock_db_read`:

```rust
/// Lock a connection mutex, recovering from poisoning.
///
/// The rule `lock_db` and `lock_db_read` both apply, in one place, over any mutex —
/// `images::Cache` holds `&Mutex<Connection>` rather than an `AppState`, so it needs the
/// rule without the state.
pub(crate) fn lock_conn(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
```

then rewrite `lock_db` and `lock_db_read` as `lock_conn(&state.db)` / `lock_conn(&state.db_read)`, and replace the inline `read.lock().unwrap_or_else(…)` in `images::Cache::get` (Task 5 Step 13) with `crate::sync::lock_conn(read)`.

- [ ] **Step 6: Fix the two `AppState` construction sites** — the field is not optional, so both fail to compile until it exists:

`lib.rs::init_state`, in the returned struct:

```rust
        client: scryfall::Client::new(SCRYFALL_API.to_owned()),
        images: images::Cache::new(data_dir.join("images")),
```
(`data_dir` is moved into the struct, so build the cache *before* the `data_dir` field or clone the join first — `images::Cache::new(data_dir.join("images"))` on a line above and pass the binding.)

`sync.rs`'s test helper `test_state`:

```rust
            client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
            images: crate::images::Cache::new(PathBuf::from("D:\\app\\data\\images")),
```

- [ ] **Step 7: Implement `serve`** — in `images.rs`, after `Cache`:

```rust
/// Answer one `mtgimg://` request.
///
/// The status codes are the contract with the renderer, and the distinction that matters
/// is permanent-versus-retryable: a printing Scryfall has no art for is a **200** with a
/// placeholder, because there is nothing to retry, while a failed fetch is a **503** so
/// the `<img>` can report an error and the UI can offer a retry. Serving a placeholder
/// for a network failure would quietly turn a temporary outage into a permanently
/// artless collection.
pub async fn serve(app: &tauri::AppHandle, path: &str) -> tauri::http::Response<Vec<u8>> {
    use tauri::http::{header, Response, StatusCode};
    use tauri::Manager;

    let fail = |status: StatusCode, message: &str, retry_after: Option<u64>| {
        let mut builder = Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/plain;charset=utf-8");
        if let Some(secs) = retry_after {
            builder = builder.header(header::RETRY_AFTER, secs.to_string());
        }
        builder
            .body(message.as_bytes().to_vec())
            .expect("static response")
    };

    let Some(key) = parse_request_path(path) else {
        return fail(StatusCode::NOT_FOUND, "not an image request", None);
    };
    let Some(state) = app.try_state::<std::sync::Arc<crate::sync::AppState>>() else {
        return fail(StatusCode::SERVICE_UNAVAILABLE, "app is still starting", Some(1));
    };

    match state
        .images
        .get(&state.client, &state.db_read, &state.db, &key)
        .await
    {
        Ok(served) => Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, served.content_type)
            // A day, not a year: the URL is stable across an image being re-scanned, so
            // an immutable cache would pin a superseded picture until the app is
            // reinstalled. A day of staleness after a re-scan is invisible; asking us on
            // every tile that scrolls past is not.
            .header(header::CACHE_CONTROL, "max-age=86400")
            .body(served.bytes)
            .expect("image response"),
        Err(ImageError::UnknownCard) => fail(StatusCode::NOT_FOUND, "no such card", None),
        Err(ImageError::RateLimited { retry_after_secs }) => fail(
            StatusCode::SERVICE_UNAVAILABLE,
            "rate limited by Scryfall",
            Some(retry_after_secs),
        ),
        Err(e) => fail(StatusCode::BAD_GATEWAY, &e.to_string(), None),
    }
}
```

- [ ] **Step 8: Register the protocol** — in `src-tauri/src/lib.rs`, add to the builder chain after the plugins and before `.invoke_handler(…)`:

```rust
        // Card art, served from the local cache. Tauri has no `registerSchemesAsPrivileged`
        // (that is Electron): registering the scheme here is what privileges it, and the
        // CSP in tauri.conf.json is what lets the page load from it. On Windows the origin
        // is `http://mtgimg.localhost/…` and elsewhere `mtgimg://localhost/…`, so only the
        // path is ever read.
        //
        // Asynchronous, because a cache miss is a network fetch: the synchronous form
        // would block the webview's resource loader — every other image on the page
        // included — for the length of one download.
        .register_asynchronous_uri_scheme_protocol("mtgimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_owned();
            tauri::async_runtime::spawn(async move {
                responder.respond(images::serve(&app, &path).await);
            });
        })
```

- [ ] **Step 9: Verify and smoke it**

```powershell
npm run verify
```
Expected: green. Then:

```powershell
npm run tauri dev
```
In the devtools console of the running app:

```js
const img = new Image();
img.onload = () => console.log("OK", img.naturalWidth, "x", img.naturalHeight);
img.onerror = (e) => console.log("FAILED", e);
img.src = "http://mtgimg.localhost/grid/" +
  // any id from the database — take one from a search result row
  "0000419b-0bba-4488-8f7a-6194544ce91d/0";
```
Expected: `OK 488 x 680` on the second attempt at the latest (the first fetches), no CSP violation, and a new file under `src-tauri/target/debug/data/images/grid/00/`. A bad id logs `FAILED` with a 404 in the network panel, not a hang.

- [ ] **Step 10: Commit**

```powershell
git add -A
git commit -m "feat: serve card images over the mtgimg:// protocol from the read-only connection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Carryover fixes — status through `db_read`, complete merge, bounded exit, doc drift

Five parked items from Plan 1, all small, all here because Plan 2 is the plan that touches the code they live in. Grouped so they are one review rather than five.

**Files:**
- Modify: `src-tauri/src/sync.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/schema.rs`, `src-tauri/src/search.rs`, `src/lib/useSync.ts`, `src/lib/useSync.test.ts`, `src/lib/ipc.ts`, `CLAUDE.md`

**Interfaces:**
- Consumes: `sync::status(state: &AppState) -> SyncStatus`, `sync::lock_conn` (Task 6), `db::lock_for` (Task 5), `mergeStatus(prev, next)`.
- Produces: `sync::status` reading through `db_read` (all five database-derived fields populated on every poll, mid-sync included); `try_lock_db` deleted; `checkpoint_on_exit` bounded; `mergeStatus` carrying `lastIngestSkipped`.
- Unchanged on purpose: the `SyncStatus` DTO shape. `cardCount` stays `Option<i64>`/`number | null` — a read that genuinely fails must still be able to say "unknown", and `mergeStatus` stays as the one place that resolves it.

- [ ] **Step 1: Rewrite the status test** — in `sync.rs`'s `mod tests`, `test_state` currently gives `db_read` *a different in-memory database*, which is exactly what a status test can no longer tolerate. Add a two-connection helper and replace `status_answers_even_while_the_database_is_held`:

```rust
    /// A real file with both connections on it — the shape `init_state` builds — because
    /// a status that reads through `db_read` cannot be tested against a `db_read` that
    /// points somewhere else.
    fn file_state(name: &str, syncing: bool) -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("mtgtest-sync-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("mtg.db");
        let conn = crate::db::open(&path).unwrap();
        schema::migrate(&conn).unwrap();
        let read = crate::db::open_read_only(&path).unwrap();
        (
            AppState {
                db: Mutex::new(conn),
                db_read: Mutex::new(read),
                data_dir: PathBuf::from("D:\\app\\data"),
                syncing: AtomicBool::new(syncing),
                client: crate::scryfall::Client::new("http://127.0.0.1:1".into()),
                images: crate::images::Cache::new(PathBuf::from("D:\\app\\data\\images")),
            },
            dir,
        )
    }

    /// The status a UI polls *during* a sync. The ingest holds the write connection for
    /// its whole run, and the header used to go blank for 44 s a day because of it — the
    /// read-only connection exists for exactly this, and under WAL it answers from the
    /// last committed snapshot without waiting for anyone.
    #[test]
    fn status_answers_real_numbers_while_the_write_connection_is_held() {
        let (state, dir) = file_state("status", true);
        {
            let conn = lock_db(&state);
            set_meta(&conn, K_LAST_CHECK_AT, "1800000000").unwrap();
            set_meta(&conn, K_LAST_ERROR, "rate limited by Scryfall").unwrap();
            set_meta(&conn, K_LAST_INGEST_SKIPPED, "12").unwrap();
            conn.execute(
                "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
                 VALUES ('x','Lightning Bolt','lea','161','en','normal','{}')",
                [],
            )
            .unwrap();
            crate::db::checkpoint_truncate(&conn).unwrap();
        }
        let state = Arc::new(state);

        // Stands in for the ingest. Called from another thread, as the real poll is, so a
        // regression to a blocking lock fails here in five seconds instead of hanging.
        let held = state.db.lock().unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        {
            let state = state.clone();
            std::thread::spawn(move || {
                let _ = tx.send(status(&state));
            });
        }
        let busy = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("status must not queue behind the writer");
        drop(held);

        assert!(busy.syncing);
        assert_eq!(busy.data_dir, "D:\\app\\data");
        assert_eq!(
            busy.card_count,
            Some(1),
            "the read connection can count cards while the writer is busy"
        );
        assert_eq!(busy.last_check_at.as_deref(), Some("1800000000"));
        assert_eq!(busy.last_error.as_deref(), Some("rate limited by Scryfall"));
        assert_eq!(busy.last_ingest_skipped, Some(12));

        drop(state);
        let _ = std::fs::remove_dir_all(&dir);
    }
```

The two other tests that call `status(&state)` (`…last_ingest_skipped, Some(12)` and the
`fresh` case around `sync.rs:1060`) keep working — move them onto `file_state` too if they
were relying on `test_state`'s separate read database.

- [ ] **Step 2: Run and watch it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sync
```
Expected: `assertion 'left == right' failed: left: None, right: Some(1)` — `status` is
still reading through `try_lock_db`.

- [ ] **Step 3: Route `status` through `db_read`** — in `sync.rs`, replace the body of `status`:

```rust
/// Current sync state for the UI.
///
/// Read through the **read-only** connection, which is what makes the header's numbers
/// stay live during a sync: the ingest holds the write connection for its whole 44 s run,
/// and this used to answer `None` for every database-derived field for the whole of it.
/// Under WAL a reader sees the last committed snapshot without blocking, so mid-sync this
/// reports the pre-swap figures — which are true, and are what the user is still looking
/// at in the results list.
///
/// The fields stay `Option` regardless: a read can still fail (a poisoned lock, a file
/// that has gone away), and `None` there means "not readable right now", never "zero".
///
/// `card_count` is counted live rather than read from `sync_meta`, so it is right even if
/// a previous run died before writing its meta.
pub fn status(state: &AppState) -> SyncStatus {
    let conn = lock_db_read(state);
    SyncStatus {
        card_count: Some(count_cards(&conn)),
        last_check_at: get_meta(&conn, K_LAST_CHECK_AT),
        bulk_updated_at: get_meta(&conn, K_BULK_UPDATED_AT),
        last_error: get_meta(&conn, K_LAST_ERROR),
        last_ingest_skipped: get_meta(&conn, K_LAST_INGEST_SKIPPED).and_then(|s| s.parse().ok()),
        data_dir: state.data_dir.display().to_string(),
        syncing: state.syncing.load(Ordering::SeqCst),
    }
}
```

- [ ] **Step 4: Delete `try_lock_db`** — it had exactly one caller. Remove the function and
the now-unused `TryLockError` import; `db::lock_for` is the bounded variant anything else
should reach for.

- [ ] **Step 5: Bound the exit checkpoint** — in `src-tauri/src/lib.rs`, replace
`checkpoint_on_exit`'s body:

```rust
/// How long the exit handler will wait for the write connection.
///
/// Quitting mid-ingest is the case this bounds: the sync holds the lock for up to ~44 s,
/// and a window-less process sitting on a lock is a process the user believes has already
/// quit. Five seconds covers every ordinary contention (a search, a status poll) and
/// gives up on the one that would be visible.
const EXIT_CHECKPOINT_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

fn checkpoint_on_exit(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<Arc<AppState>>() else {
        return;
    };
    // The *write* connection: a read-only handle may not checkpoint. Bounded, because
    // the alternative is parking a window-less process for the length of an ingest — and
    // a skipped checkpoint costs disk space, never data. The WAL is a complete journal
    // and the next launch replays it.
    match db::lock_for(&state.db, EXIT_CHECKPOINT_WAIT) {
        Some(conn) => {
            let _ = db::checkpoint_truncate(&conn);
        }
        None => eprintln!(
            "skipped the exit checkpoint: a sync still holds the database. \
             The write-ahead log will be folded in on the next launch."
        ),
    }
}
```

- [ ] **Step 6: Complete `mergeStatus`** — in `src/lib/useSync.ts`:

```ts
/**
 * Fold a fresh poll into what the UI already knows.
 *
 * Since `sync::status` reads through the read-only connection this is no longer a
 * once-a-day event — mid-sync polls now carry real numbers. It stays because the fields
 * are still nullable and a read can still fail (a poisoned lock, a file that moved), and
 * a `null` there means "not readable right now", not "zero" and not "cleared": rendering
 * it literally would blank the card count and throw away an error banner the user has
 * not read yet.
 *
 * `cardCount` is the discriminator: `status()` fills it in for *every* poll that read the
 * database (a failed count reads as 0, never as `None`), so a non-null count means the
 * whole group was read and its nulls are real — including a `lastError` the last run
 * cleared, which must be allowed to land.
 */
export function mergeStatus(prev: SyncStatus | null, next: SyncStatus): SyncStatus {
  if (next.cardCount !== null) return next;
  return {
    ...next,
    cardCount: prev?.cardCount ?? null,
    lastCheckAt: prev?.lastCheckAt ?? null,
    bulkUpdatedAt: prev?.bulkUpdatedAt ?? null,
    lastError: prev?.lastError ?? null,
    // Carried like the rest. Nothing rendered it when this function was written, so its
    // absence was invisible; the card detail pane and the settings view will render it,
    // and a count that blinked to "unknown" on an unreadable poll would read as an
    // ingest that suddenly stopped skipping lines.
    lastIngestSkipped: prev?.lastIngestSkipped ?? null,
  };
}
```

- [ ] **Step 7: Test the merge** — in `src/lib/useSync.test.ts`, extend the first case:

```ts
    expect(merged.lastError).toBe("rate limited by Scryfall");
    expect(merged.lastIngestSkipped).toBe(12);
```

and add:

```ts
  it("lets a cleared skip count land once the database is readable again", () => {
    const cleared: SyncStatus = { ...idle, lastIngestSkipped: null, cardCount: 116_600 };

    expect(mergeStatus(idle, cleared).lastIngestSkipped).toBeNull();
  });
```

- [ ] **Step 8: Fix the doc drift** — four one-line corrections:

1. `src-tauri/src/schema.rs`, `swap_staging`'s doc comment: delete the **second** copy of the
   paragraph beginning *"The FTS table is dropped and rebuilt rather than migrated"* (it
   appears twice, at lines ~197 and ~201).
2. `src-tauri/src/sync.rs`, `SyncStatus`'s doc: *"The four database-derived fields"* →
   *"The five database-derived fields"*, and rewrite the sentence after it, which now
   describes something that no longer happens:

```rust
/// `syncing` and `data_dir` are always answered. The five database-derived fields are
/// `None` only when the read-only connection could not be used at all — not, as they once
/// were, for the whole of every ingest (see [`status`]). `None` there means "not readable
/// right now", never "zero"; a UI should keep showing its last value rather than render
/// an empty collection.
```

3. `src/lib/ipc.ts`, `SyncStatus`'s doc: *"The four database-derived fields are `null`
   whenever the database could not be locked — which for the whole of an ingest it
   cannot."* → *"The five database-derived fields are `null` only when the read-only
   connection could not be used at all; an ingest no longer blanks them."*
4. `src-tauri/src/search.rs`, module doc: *"Only three things are ever interpolated into
   the SQL string — a colour letter from a fixed array, a `FROM` clause picked from two
   literals, and an `ORDER BY` picked from four"* → *"Only four things are ever
   interpolated into the SQL string — a colour letter from a fixed array, a `FROM` clause
   picked from two literals, an `ORDER BY` picked from four, and the constant row cap on
   the count"*.

- [ ] **Step 9: Update CLAUDE.md** — two edits.

Narrow the FTS rule to what it actually guards (the carryover adjudicated this; Task 2 ships
the evidence). Replace the `cards_fts` bullet under **Hard rules — database**:

```markdown
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the
  ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` **if it touches
  an indexed column (`name`/`type_line`/`search_text`) or renumbers rowids** — and `VACUUM`
  does the latter, so it always needs one. A migration that only adds and fills unindexed
  columns does not (schema v2; `the_v2_backfill_leaves_the_search_index_answering` is the
  proof).
```

and add to **Hard rules**, after the shadcn bullet:

```markdown
- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where
  the origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere.
  Variants are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never
  fetched. The handler reads through `db_read`, never the write connection. `app.security.csp`
  is not `null` any more — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
```

- [ ] **Step 10: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "fix: keep sync status live through db_read, bound the exit checkpoint, complete mergeStatus

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---


### Task 8: Visual foundation and the global ribbon

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** Palette, type roles, the mana line and the ribbon layout are all specified there. Spend judgment on detail quality (spacing, focus states, contrast), not on the direction.

This is the first UI task, and it comes after the Rust work on purpose: Task 7 changes what `sync::status` reports and how `mergeStatus` folds it, and the ribbon's mana line is driven by exactly that. Building the ribbon first would mean building it twice.

**Files:**
- Modify: `package.json`, `src/index.css`, `src/components/AppShell.tsx`, `src/components/AppShell.test.tsx`, `src/components/SyncProgress.tsx`, `src/components/SyncProgress.test.tsx`
- Create: `src/lib/mana.ts`, `src/lib/mana.test.ts`, `src/lib/rarity.ts`, `src/lib/rarity.test.ts`, `src/lib/useSyncProgress.ts`, `src/components/ManaLine.tsx`, `src/components/ManaLine.test.tsx`, `src/components/Ribbon.tsx`, `src/components/Ribbon.test.tsx`

**Interfaces:**
- Consumes: `useSync()` → `{ status, error, refresh, refreshing, upToDate }` and `statusLine(status)` from `src/lib/useSync.ts`; `SyncProgressEvent { phase, done, total, message }` and `SyncPhase` from `src/lib/ipc.ts`; `useAppStore` → `{ activeView, setActiveView }`; `cn` from `@/lib/utils`.
- Produces:

```ts
// src/lib/mana.ts
export const MANA_KEYS = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaKey = (typeof MANA_KEYS)[number];
export const MANA_LINE_KEYS = ["W", "U", "B", "R", "G"] as const;  // no C in the line
/** The `mana-font` class pair for one symbol: `"ms ms-w"`. */
export function manaSymbolClass(key: ManaKey): string;
/** The five-colour gradient, as a CSS `linear-gradient(...)` value. */
export const MANA_LINE_GRADIENT: string;
export interface ManaLineSync { value: number | null; label: string }
export function manaLineSync(progress: SyncProgressEvent | null, busy: boolean): ManaLineSync | null;

// src/lib/rarity.ts
/** The CSS colour for a rarity gem or tinted label. Unknown rarities get the border colour. */
export function rarityColor(rarity: string | null): string;

// src/lib/useSyncProgress.ts
export const PHASE_LABEL: Record<SyncPhase, string>;      // moved out of SyncProgress.tsx
export function useSyncProgress(): SyncProgressEvent | null;

// src/components/ManaLine.tsx
export function ManaLine({ sync }: { sync: ManaLineSync | null }): JSX.Element;

// src/components/Ribbon.tsx
export interface RibbonProps {
  title: string; statusLine: string | null; dataDir: string | undefined;
  busy: boolean; upToDate: boolean; hasError: boolean;
  onRefresh: () => void; sync: ManaLineSync | null;
}
export function Ribbon(props: RibbonProps): JSX.Element;
```

**Packages** — verified live on the npm registry at authoring time, and all four are **bundled by Vite, never a CDN** (the CSP has no remote source and never will):

| package | version | entry | what it gives |
|---|---|---|---|
| `@fontsource/cinzel` | 5.3.0 | `500.css`, `600.css` subpaths | display face; static weights, which is what the direction asks for |
| `@fontsource-variable/geist-mono` | 5.3.0 | `index.css` | the data face (`--font-mono`) |
| `mana-font` | 1.18.0 | `css/mana.css` | `.ms` + `.ms-w/u/b/r/g/c`, `.ms-cost`, `.ms-shadow`; fonts in `fonts/` (woff/ttf/eot/svg — the shipped CSS does **not** reference the woff2 that is also in the tarball; woff is fine in WebView2) |
| `keyrune` | 3.19.0 | `css/keyrune.css` | `.ss` + 441 `.ss-<setcode>` classes (e.g. `.ss-lea`), rarity modifiers, woff2 |

Two things to know about `mana-font/css/mana.css` before wiring it: it also declares an `MPlantin` `@font-face` this app does not use (harmless, and the file only loads when a glyph needs it), and `.ms` defines its own `--ms-mana-*` variables whose values differ slightly from the direction doc's fills (`#fdfbce` vs `#FFFBD5`). **The direction doc wins** — chips are filled from our tokens, and the font supplies the glyph only.

- [ ] **Step 1: Install**

```powershell
npm i @fontsource/cinzel @fontsource-variable/geist-mono mana-font keyrune
```
Expected: four packages added, no peer warnings. Confirm the resolved versions are ≥ the table above.

- [ ] **Step 2: Write the failing token/helper tests** — create `src/lib/mana.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SyncProgressEvent } from "@/lib/ipc";
import { MANA_KEYS, MANA_LINE_GRADIENT, manaLineSync, manaSymbolClass } from "@/lib/mana";

const event = (over: Partial<SyncProgressEvent> = {}): SyncProgressEvent => ({
  phase: "ingesting",
  done: 0,
  total: 0,
  message: null,
  ...over,
});

describe("manaSymbolClass", () => {
  /** `mana-font` keys its glyphs on lowercase letters; the app spells colours WUBRG. */
  it("names the mana-font glyph for every chip, colourless included", () => {
    expect(manaSymbolClass("W")).toBe("ms ms-w");
    expect(manaSymbolClass("C")).toBe("ms ms-c");
    expect(MANA_KEYS).toHaveLength(6);
  });
});

describe("MANA_LINE_GRADIENT", () => {
  /** The signature element. Five colours, in WUBRG order, and no colourless — the line is
   *  the colour pie, not the filter row. */
  it("runs W→U→B→R→G in order", () => {
    const order = ["--color-mana-w", "--color-mana-u", "--color-mana-b", "--color-mana-r", "--color-mana-g"];
    const positions = order.map((token) => MANA_LINE_GRADIENT.indexOf(token));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(MANA_LINE_GRADIENT).not.toContain("--color-mana-c");
  });
});

describe("manaLineSync", () => {
  it("is null when nothing is running — the line is then just the line", () => {
    expect(manaLineSync(null, false)).toBeNull();
    expect(manaLineSync(event({ phase: "ingesting", done: 5, total: 10 }), false)).toBeNull();
  });

  it("reports a fraction when the phase has a denominator", () => {
    const sync = manaLineSync(event({ phase: "downloading", done: 5, total: 10 }), true);

    expect(sync?.value).toBe(0.5);
    expect(sync?.label).toMatch(/downloading/i);
  });

  /**
   * `checking` and `sets` carry no total, and a run throttled by the 24 h window emits no
   * event at all while `sync_run` is still in flight. Both are "busy, length unknown" —
   * a `value` of 0 would claim no progress had been made.
   */
  it("is indeterminate when the phase has no denominator, and while no event has arrived", () => {
    expect(manaLineSync(event({ phase: "checking" }), true)?.value).toBeNull();
    expect(manaLineSync(null, true)?.value).toBeNull();
  });

  it("treats a finished or failed run as not running", () => {
    expect(manaLineSync(event({ phase: "done", done: 9, total: 9 }), true)?.value).toBeNull();
    expect(manaLineSync(event({ phase: "error" }), true)?.value).toBeNull();
  });

  it("never runs past the end", () => {
    expect(manaLineSync(event({ phase: "ingesting", done: 130_000, total: 117_000 }), true)?.value).toBe(1);
  });
});
```

- [ ] **Step 3: Run and watch it fail**

```powershell
npm run test:run -- src/lib/mana.test.ts
```
Expected: `Failed to resolve import "@/lib/mana"`.

- [ ] **Step 4: Implement the mana module** — create `src/lib/mana.ts`:

```ts
/**
 * Magic's colour pie, as the interface uses it.
 *
 * The direction doc's thesis: colour appears only where it carries Magic meaning. This
 * module is the whole of that vocabulary — the five (plus colourless) symbol keys, the
 * `mana-font` class names that draw them, and the gradient behind the app's one signature
 * element. Nothing else in the app invents a colour.
 */
import type { SyncPhase, SyncProgressEvent } from "@/lib/ipc";
import { PHASE_LABEL } from "@/lib/useSyncProgress";

/** The filter chips: WUBRG plus colourless. */
export const MANA_KEYS = ["W", "U", "B", "R", "G", "C"] as const;
export type ManaKey = (typeof MANA_KEYS)[number];

/**
 * The mana line is the colour *pie*, not the filter row — five colours, no colourless.
 * WUBRG order is not a preference: it is the order the symbols are printed in.
 */
export const MANA_LINE_KEYS = ["W", "U", "B", "R", "G"] as const;

export const MANA_LABEL: Record<ManaKey, string> = {
  W: "White",
  U: "Blue",
  B: "Black",
  R: "Red",
  G: "Green",
  C: "Colorless",
};

/**
 * The `mana-font` classes that draw one symbol.
 *
 * The glyph comes from the bundled font; the *fill* comes from our own tokens, because
 * `mana-font`'s built-in `--ms-mana-*` values are a shade off the direction doc's
 * (`#fdfbce` where the doc says `#FFFBD5`) and the doc is what is binding.
 */
export function manaSymbolClass(key: ManaKey): string {
  return `ms ms-${key.toLowerCase()}`;
}

/**
 * The signature: a soft W→U→B→R→G blend, written against the theme tokens so the line and
 * the chips can never drift apart.
 */
export const MANA_LINE_GRADIENT = `linear-gradient(90deg, var(--color-mana-w) 0%, var(--color-mana-u) 25%, var(--color-mana-b) 50%, var(--color-mana-r) 75%, var(--color-mana-g) 100%)`;

/** What the mana line is showing, or `null` when it is just a line. */
export interface ManaLineSync {
  /** 0–1, or `null` for a phase with no denominator. */
  value: number | null;
  label: string;
}

/**
 * Fold a sync into what the line should draw.
 *
 * `busy` decides, not the event: a run inside the 24 h check window emits nothing at all,
 * and Tauri drops the events emitted before the webview started listening — so an event
 * is evidence of progress, never of running. `done` and `error` are terminal phases whose
 * event can outlive the run by a poll interval, so they read as indeterminate rather than
 * as a full or empty bar.
 */
export function manaLineSync(
  progress: SyncProgressEvent | null,
  busy: boolean,
): ManaLineSync | null {
  if (!busy) return null;
  const phase: SyncPhase | null =
    progress && progress.phase !== "done" && progress.phase !== "error" ? progress.phase : null;
  if (!phase || !progress) return { value: null, label: "Syncing card data" };
  return {
    value: progress.total > 0 ? Math.min(1, progress.done / progress.total) : null,
    label: PHASE_LABEL[phase],
  };
}
```

- [ ] **Step 5: Extract the progress listener** — create `src/lib/useSyncProgress.ts` by moving `PHASE_LABEL` and `useSyncProgress` out of `src/components/SyncProgress.tsx` verbatim, exporting both. Two components need them now (the ribbon's line and the first-run overlay), and a second `listen` registration for the same event would be a second subscription for the life of the app.

- [ ] **Step 5b: The rarity gem** — create `src/lib/rarity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { rarityColor } from "@/lib/rarity";

describe("rarityColor", () => {
  it("maps the four rarities the direction names", () => {
    expect(rarityColor("common")).toBe("var(--color-rarity-common)");
    expect(rarityColor("mythic")).toBe("var(--color-rarity-mythic)");
  });

  /**
   * Scryfall also emits `special` and `bonus`, and `rarity` is nullable. Neither has a
   * token, and inventing one would be a colour claim the direction did not make — the
   * border colour reads as "no rarity stated", which is the truth.
   */
  it("makes no colour claim about a rarity it has no token for", () => {
    expect(rarityColor("special")).toBe("var(--color-border)");
    expect(rarityColor("bonus")).toBe("var(--color-border)");
    expect(rarityColor(null)).toBe("var(--color-border)");
  });
});
```

then `src/lib/rarity.ts`:

```ts
/**
 * Rarity, as a colour.
 *
 * Four tokens and a fallback. The direction spends its colour budget on mana and card
 * art, so a rarity gets a 6px gem or a tinted word — never a filled badge, which at
 * mythic orange would out-shout the art it sits under.
 */
export function rarityColor(rarity: string | null): string {
  switch (rarity) {
    case "common":
      return "var(--color-rarity-common)";
    case "uncommon":
      return "var(--color-rarity-uncommon)";
    case "rare":
      return "var(--color-rarity-rare)";
    case "mythic":
      return "var(--color-rarity-mythic)";
    // `special` and `bonus` exist in the data and have no token of their own.
    default:
      return "var(--color-border)";
  }
}
```

```powershell
npm run test:run -- src/lib/rarity.test.ts
```
Expected: 2 passed.

- [ ] **Step 6: Run the mana tests**

```powershell
npm run test:run -- src/lib/mana.test.ts
```
Expected: 8 passed.

- [ ] **Step 7: Extend the theme** — in `src/index.css`.

Add to the import block at the top, after the existing `@fontsource-variable/geist` line (CSS `@import` rules must all precede other rules, and Vite resolves bare package specifiers here — this is the same mechanism the Geist import already uses):

```css
@import "@fontsource-variable/geist-mono";
@import "@fontsource/cinzel/500.css";
@import "@fontsource/cinzel/600.css";
@import "mana-font/css/mana.css";
@import "keyrune/css/keyrune.css";
```

In the `@theme inline` block, repoint the display face — this is the one hook that makes every existing `font-heading` usage Cinzel at once:

```css
    --font-heading: 'Cinzel', Georgia, serif;
    --font-mono: 'Geist Mono Variable', ui-monospace, monospace;
```

And extend the app-palette `@theme` block at the bottom with the direction doc's values, verbatim:

```css
  /* The five colours, as printed symbols are filled. Mana UI only — chips, pips, the
     line. Never a panel, never a border, never text. Glyphs sit on these in near-black,
     exactly like a real symbol. */
  --color-mana-w: #FFFBD5;
  --color-mana-u: #AAE0FA;
  --color-mana-b: #CBC2BF;
  --color-mana-r: #F9AA8F;
  --color-mana-g: #9BD3AE;
  --color-mana-c: #C8C4BF;

  /* Frame/pie deeps — saturated enough to carry meaning at 1px. For identity pips and,
     later, charts. Not interchangeable with the fills above. */
  --color-pie-w: #F8E7B9;
  --color-pie-u: #0E68AB;
  --color-pie-b: #3B3A3E;
  --color-pie-r: #D3202A;
  --color-pie-g: #00733E;
  --color-pie-gold: #D9B95C;
  --color-pie-c: #C8C4BF;

  /* Rarity, as a gem dot or tinted text. Nothing bigger — a rarity is a footnote. */
  --color-rarity-common: #9AA0A6;
  --color-rarity-uncommon: #B3C7CE;
  --color-rarity-rare: #BFA35A;
  --color-rarity-mythic: #E86A33;

  /* The one animation in the app: the mana line's sweep while a sync has no denominator.
     Held to 150ms elsewhere per the direction's motion budget. */
  --animate-mana-sweep: mana-sweep 1.6s ease-in-out infinite;
```

and after the `@theme` block:

```css
@keyframes mana-sweep {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(200%); }
}
```

- [ ] **Step 8: Write the failing ManaLine test** — create `src/components/ManaLine.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ManaLine } from "./ManaLine";

describe("ManaLine", () => {
  /**
   * At rest it is decoration — the app's signature, carrying no information a screen
   * reader could use. Announcing a 0% progress bar on every screen would be noise.
   */
  it("is a silent rule when nothing is syncing", () => {
    const { container } = render(<ManaLine sync={null} />);

    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(container.firstChild).toHaveAttribute("aria-hidden", "true");
  });

  it("becomes the progress bar during a sync", () => {
    render(<ManaLine sync={{ value: 0.42, label: "Downloading card data" }} />);

    const bar = screen.getByRole("progressbar", { name: "Downloading card data" });
    expect(bar).toHaveAttribute("aria-valuenow", "42");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
  });

  /** `aria-valuenow="0"` would be a claim that no progress has been made; omitting it is
   *  ARIA's way of saying the length is unknown. */
  it("omits the value when the phase has no denominator", () => {
    render(<ManaLine sync={{ value: null, label: "Checking for card data updates" }} />);

    const bar = screen.getByRole("progressbar", { name: /checking/i });
    expect(bar).not.toHaveAttribute("aria-valuenow");
  });
});
```

- [ ] **Step 9: Run and watch it fail**

```powershell
npm run test:run -- src/components/ManaLine.test.tsx
```
Expected: `Failed to resolve import "./ManaLine"`.

- [ ] **Step 10: Implement** — create `src/components/ManaLine.tsx`:

```tsx
import { MANA_LINE_GRADIENT, type ManaLineSync } from "@/lib/mana";
import { cn } from "@/lib/utils";

/**
 * The app's signature, and its only progress bar.
 *
 * A 2px W→U→B→R→G rule under the ribbon, present on every screen. During a sync the rule
 * dims and a full-strength copy of itself fills across it behind a gold cap — the one
 * place where the identity element and a functional one are the same element. It is never
 * repeated anywhere else in the app, which is what makes it a signature rather than a
 * motif.
 */
export function ManaLine({ sync }: { sync: ManaLineSync | null }) {
  if (!sync) {
    return (
      <div
        aria-hidden="true"
        className="h-0.5 w-full shrink-0"
        style={{ background: MANA_LINE_GRADIENT }}
      />
    );
  }

  const percent = sync.value === null ? null : Math.round(sync.value * 100);
  return (
    <div
      role="progressbar"
      aria-label={sync.label}
      aria-valuemin={0}
      aria-valuemax={100}
      // Omitted rather than zeroed when the length is unknown — see the test.
      {...(percent === null ? {} : { "aria-valuenow": percent })}
      className="relative h-0.5 w-full shrink-0 overflow-hidden"
    >
      {/* The line itself, held back so the fill reads as progress across it. */}
      <div
        className="absolute inset-0 opacity-30"
        style={{ background: MANA_LINE_GRADIENT }}
      />
      {percent === null ? (
        // No denominator: a short segment sweeps instead of a bar filling. Suppressed
        // under prefers-reduced-motion, where the dimmed line alone says "busy".
        <div
          className="absolute inset-y-0 left-0 w-1/3 animate-mana-sweep motion-reduce:animate-none motion-reduce:hidden"
          style={{ background: MANA_LINE_GRADIENT }}
        />
      ) : (
        <div
          className="absolute inset-y-0 left-0 transition-[width] duration-150 ease-out motion-reduce:transition-none"
          style={{ width: `${percent}%`, background: MANA_LINE_GRADIENT }}
        >
          {/* The gold cap: the accent colour marking the leading edge, so the boundary
              between done and not-done is legible against five shifting hues. */}
          <span className={cn("absolute inset-y-0 right-0 w-0.5 bg-accent")} />
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 11: Run it**

```powershell
npm run test:run -- src/components/ManaLine.test.tsx
```
Expected: 3 passed.

- [ ] **Step 12: Write the failing Ribbon test** — create `src/components/Ribbon.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Ribbon, type RibbonProps } from "./Ribbon";

const props = (over: Partial<RibbonProps> = {}): RibbonProps => ({
  title: "Search",
  statusLine: "116,568 cards · data from 2026-08-03",
  dataDir: "D:\\app\\data",
  busy: false,
  upToDate: false,
  hasError: false,
  onRefresh: vi.fn(),
  sync: null,
  ...over,
});

describe("Ribbon", () => {
  /** Global actions live here now, not in a view — that is the whole point of the row. */
  it("carries the view title, the status line and Refresh", () => {
    render(<Ribbon {...props()} />);

    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Search");
    expect(screen.getByText("116,568 cards · data from 2026-08-03")).toHaveAttribute(
      "title",
      "D:\\app\\data",
    );
    expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
  });

  it("runs and then refuses a second sync while one is in flight", async () => {
    const onRefresh = vi.fn();
    const { rerender } = render(<Ribbon {...props({ onRefresh })} />);

    await userEvent.click(screen.getByRole("button", { name: /refresh/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);

    rerender(<Ribbon {...props({ onRefresh, busy: true })} />);
    expect(screen.getByRole("button", { name: /refresh/i })).toBeDisabled();
  });

  it("says a Refresh found nothing, and only when there is nothing louder to say", () => {
    const { rerender } = render(<Ribbon {...props({ upToDate: true })} />);
    expect(screen.getByText(/already up to date/i)).toBeInTheDocument();

    // An error banner is showing below; repeating a cheerful line beside it is noise.
    rerender(<Ribbon {...props({ upToDate: true, hasError: true })} />);
    expect(screen.queryByText(/already up to date/i)).not.toBeInTheDocument();
  });

  it("hands the sync to the mana line", () => {
    render(<Ribbon {...props({ busy: true, sync: { value: 0.5, label: "Importing cards" } })} />);

    expect(screen.getByRole("progressbar", { name: "Importing cards" })).toHaveAttribute(
      "aria-valuenow",
      "50",
    );
  });
});
```

- [ ] **Step 13: Run and watch it fail**

```powershell
npm run test:run -- src/components/Ribbon.test.tsx
```
Expected: `Failed to resolve import "./Ribbon"`.

- [ ] **Step 14: Implement** — create `src/components/Ribbon.tsx`:

```tsx
import { RefreshCw } from "lucide-react";
import { ManaLine } from "@/components/ManaLine";
import type { ManaLineSync } from "@/lib/mana";
import { cn } from "@/lib/utils";

export interface RibbonProps {
  /** The active view's name. The one string in the chrome set in Cinzel. */
  title: string;
  /** Already formatted by `statusLine`, or `null` before the first poll answers. */
  statusLine: string | null;
  /** Tooltip on the status line: which data folder is live (spec §3). */
  dataDir: string | undefined;
  /** A sync is running — this window's Refresh, or the one spawned at startup. */
  busy: boolean;
  /** The last Refresh came back with nothing new. */
  upToDate: boolean;
  /** An error banner is showing below; the ribbon stays out of its way. */
  hasError: boolean;
  onRefresh: () => void;
  /** Drives the mana line. `null` when nothing is running. */
  sync: ManaLineSync | null;
}

/**
 * The global ribbon: one 48px row that owns every action which is not about the view
 * below it.
 *
 * Refresh and the sync status used to live in a per-view header, which made them look
 * like properties of whatever was on screen. They are properties of the *app*, so they
 * belong in one place that never changes — and the mana line beneath is what marks that
 * place as the app's edge rather than the content's.
 */
export function Ribbon({
  title,
  statusLine,
  dataDir,
  busy,
  upToDate,
  hasError,
  onRefresh,
  sync,
}: RibbonProps) {
  return (
    <div className="shrink-0">
      <div className="flex h-12 items-center gap-3 bg-surface px-4">
        {/* The mark, not the product name: the window title bar already says that in full,
            and 48px of vertical space is not where a five-word name earns its keep. */}
        <span aria-hidden="true" className="font-heading text-lg leading-none text-accent">
          MTG
        </span>
        <span aria-hidden="true" className="h-4 w-px bg-border" />
        {/* Cinzel's only job in the chrome, and never below 18px — the direction is
            explicit that the display face is for titles, not for interface text. */}
        <h1 className="truncate font-heading text-lg leading-none">{title}</h1>

        <div className="ml-auto flex min-w-0 items-center gap-3">
          {upToDate && !busy && !hasError && (
            <p role="status" className="shrink-0 text-xs text-muted">
              Already up to date
            </p>
          )}
          {statusLine && (
            <p className="truncate text-xs text-muted" title={dataDir}>
              {statusLine}
            </p>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={busy}
            aria-busy={busy || undefined}
            className={cn(
              "inline-flex shrink-0 items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm",
              "transition-colors duration-150 hover:bg-bg",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
              "disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
            )}
          >
            <RefreshCw
              className={cn("size-4", busy && "animate-spin motion-reduce:animate-none")}
              aria-hidden="true"
            />
            Refresh data
          </button>
        </div>
      </div>
      <ManaLine sync={sync} />
    </div>
  );
}
```

- [ ] **Step 15: Run it**

```powershell
npm run test:run -- src/components/Ribbon.test.tsx
```
Expected: 4 passed.

- [ ] **Step 16: Restructure `AppShell`** — `src/components/AppShell.tsx`:

1. Delete the whole `<header>` block; the app mark, status line, "Already up to date" and Refresh button now live in `Ribbon`.
2. Render `<Ribbon …/>` in its place, fed from the hooks `AppShell` already owns:

```tsx
export function AppShell({ children }: { children: ReactNode }) {
  const activeView = useAppStore((s) => s.activeView);
  const setActiveView = useAppStore((s) => s.setActiveView);
  const { status, error, refresh, refreshing, upToDate } = useSync();
  const progress = useSyncProgress();

  // Either this window started the sync or something else did (the run spawned at
  // startup, most often). A second `sync_run` would only be refused.
  const busy = refreshing || status?.syncing === true;
  const title = NAV.find((n) => n.id === activeView)?.label ?? "";

  return (
    <div className="flex h-screen overflow-hidden bg-bg text-text">
      <nav aria-label="Views" className="flex w-52 shrink-0 flex-col gap-1 border-r border-border bg-surface p-3">
        {NAV.map(({ id, label, Icon }) => {
          const active = id === activeView;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setActiveView(id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "relative flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm",
                "transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                // The gold indicator: a hairline against the item, not a filled pill. The
                // sidebar is chrome, and chrome does not get to be the loudest thing on a
                // screen that is about to be full of card art.
                active
                  ? "bg-bg text-accent before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                  : "text-muted hover:bg-bg/60 hover:text-text",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <Ribbon
          title={title}
          statusLine={statusLine(status)}
          dataDir={status?.dataDir}
          busy={busy}
          upToDate={upToDate}
          hasError={error !== null}
          onRefresh={refresh}
          sync={manaLineSync(progress, busy)}
        />

        {/* Given the whole screen when the database is empty, so it needs the error and
            the retry action too: it covers the ribbon, Refresh button included. */}
        <SyncProgress cardCount={status?.cardCount ?? null} error={error} busy={busy} onRetry={refresh} />

        {error && (
          <div
            role="alert"
            className="flex shrink-0 items-start gap-2 border-b border-destructive/40 bg-destructive/10 px-5 py-2 text-sm text-destructive"
          >
            <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0">{error}</span>
          </div>
        )}

        <main className="min-h-0 flex-1 overflow-auto p-5">{children}</main>
      </div>
    </div>
  );
}
```

3. Imports: drop `RefreshCw`, add `Ribbon`, `manaLineSync`, `useSyncProgress`.

- [ ] **Step 17: Reduce `SyncProgress` to the first-run overlay** — `src/components/SyncProgress.tsx`:

1. Delete `PHASE_LABEL` and `useSyncProgress` (they moved in Step 5) and import them from `@/lib/useSyncProgress`.
2. Delete the slim in-line bar entirely — the branch that returns the `<div className="flex items-center gap-3 border-b …">`. The mana line is now the app's only progress bar, and two of them on one screen is exactly the kind of repetition the direction's boldness budget forbids. `SyncProgress` becomes:

```tsx
export function SyncProgress({ cardCount, error, busy, onRetry }: SyncProgressProps) {
  const progress = useSyncProgress();

  // `cardCount === 0` — and only `0` — means an empty database, so the app has nothing to
  // show and the first sync gets the whole screen. `null` means the poll could not read
  // the count; treating that as empty would black out a working 116 k-card app.
  //
  // Every other sync is reported by the ribbon's mana line, which is why there is no
  // second, slimmer bar here any more.
  if (cardCount === 0 && progress?.phase !== "done") {
    return <FirstRun progress={progress} error={error} busy={busy} onRetry={onRetry} />;
  }
  return null;
}
```

3. `FirstRun` keeps its own `Bar` (it is a full-screen hero, not the chrome) and its `<h2 className="font-heading text-2xl">` now renders in Cinzel automatically — check it still reads well at that size and leave it.

- [ ] **Step 18: Fix the tests the restructure breaks** — three edits, no more:

1. `src/components/AppShell.test.tsx`, first test: `screen.getByText("Search")` is now ambiguous, because the ribbon renders the active view's title with the same word. Switch all five nav assertions to the role query the last test in the file already uses:

```tsx
  expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collection" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Wishlist" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Decks" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
```

2. `src/components/SyncProgress.test.tsx`: delete `describe("the slim variant", …)` in full — all four of its tests describe a component that no longer exists. The behaviour they covered now lives in `ManaLine.test.tsx` and `Ribbon.test.tsx`.

3. `src/components/SyncProgress.test.tsx`, `"does not mistake an unreadable count for an empty database"`: it asserts the slim bar is present. Keep the test, change the assertion to what the component now promises:

```tsx
    const { container } = render(/* …unchanged… */);
    emit(event({ phase: "ingesting", done: 1, total: 117_000 }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // An unreadable count is not an empty database, so this renders nothing at all — the
    // ribbon's mana line is what reports the run.
    expect(container).toBeEmptyDOMElement();
```

- [ ] **Step 19: Verify**

```powershell
npm run verify
```
Expected: green. `App.test.tsx` needs no change — it queries `heading … level: 2`, and the ribbon's title is an `h1`.

- [ ] **Step 20: Manual smoke**

```powershell
npm run tauri dev
```
Expected: a 48px `bg-surface` ribbon with the gold "MTG" mark, the view title in Cinzel, the status line and **Refresh data** on the right, and a 2px WUBRG line beneath it. During a Refresh the line dims and fills left→right behind a gold cap. The sidebar's active item shows a gold hairline. Fonts are served from the app origin — check the devtools network panel for **zero** requests to any external host, and the console for zero CSP violations.

- [ ] **Step 21: Commit**

```powershell
git add -A
git commit -m "feat: visual foundation — mana tokens, Cinzel display face, global ribbon with the mana line

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Set and mana-value filters in `search_cards`, and a `list_sets` command

The backend half of the filter expansion. No UI here — Task 10 spends its whole budget on the chips.

**Files:**
- Modify: `src-tauri/src/search.rs`, `src-tauri/src/lib.rs` (command registration)

**Interfaces:**
- Consumes: `run_search(conn: &Connection, req: &SearchRequest) -> Result<SearchResponse, String>` and its `wheres`/`params`/`where_sql` assembly; `sync::{lock_db_read, AppState}`; the `sets` table (`code` PK, `name`, `arena_code`, `mtgo_code`, `set_type`, `released_at`, `icon_svg_uri`).
- Produces:

```rust
pub struct SearchRequest {
    // …every existing field, unchanged…
    /// Set codes, ORed together and ANDed with everything else.
    pub sets: Option<Vec<String>>,
    /// Discrete mana values. 0–7 match `cmc` exactly; 8 means "8 or more".
    pub mana_values: Option<Vec<u8>>,
}

pub struct SetSummary {
    pub code: String, pub name: String, pub set_type: Option<String>,
    pub released_at: Option<String>, pub card_count: i64,
}
pub fn run_list_sets(conn: &Connection) -> Result<Vec<SetSummary>, String>;
#[tauri::command] pub async fn list_sets(state) -> Result<Vec<SetSummary>, String>;
```

- `setCode` (the existing single-set field) stays: it is the one-set shorthand and is already tested. The UI stops sending it in Task 10 and sends `sets` instead; both AND together if a caller sends both.
- No new index: `idx_cards_set_cn` already leads on `set_code`, and `cmc` filters run over whatever the other predicates leave.

- [ ] **Step 1: Write the failing tests** — add to `search.rs`'s `mod tests`. The existing `seeded()` has three rows and no `cmc`, so add a second fixture rather than disturbing it:

```rust
    /// Four printings across three sets with known mana values, including a NULL one —
    /// `cmc` is nullable and reversible cards genuinely have none.
    #[rustfmt::skip]
    fn seeded_costs() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows: [(&str, &str, &str, Option<f64>, &str); 4] = [
            ("1", "Lightning Bolt",  "lea", Some(1.0),  "R"),
            ("2", "Wrath of God",    "lea", Some(4.0),  "W"),
            ("3", "Emrakul",         "roe", Some(15.0), ""),
            ("4", "Jinnie Fay",      "sld", None,       "G"),
        ];
        for (id, name, set, cmc, ci) in rows {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,cmc,color_identity,
                    legalities,is_paper,search_text,raw)
                 VALUES (?1,?2,?3,'1','en','normal',?4,?5,'{\"modern\":\"legal\"}',1,?2,'{}')",
                rusqlite::params![id, name, set, cmc, ci],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn
    }

    fn names(r: &SearchResponse) -> Vec<&str> {
        r.items.iter().map(|c| c.name.as_str()).collect()
    }

    /// Two sets means "either", not "both" — the latter is always empty, and a filter that
    /// can only ever return nothing is a filter nobody would ship.
    #[test]
    fn several_sets_are_ored_together() {
        let conn = seeded_costs();
        let r = run_search(
            &conn,
            &SearchRequest {
                sets: Some(vec!["lea".into(), "roe".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(r.total, 3);
        assert_eq!(names(&r), ["Emrakul", "Lightning Bolt", "Wrath of God"]);
    }

    /// The chips are discrete: 8 is the open-ended one, and everything below it is an
    /// exact match. `cast(cmc as int)` would put a 0.5 un-card under "0", which is a
    /// different claim than the one the chip makes.
    #[test]
    fn mana_value_chips_match_exactly_except_the_open_ended_one() {
        let conn = seeded_costs();

        let one = run_search(&conn, &SearchRequest { mana_values: Some(vec![1]), limit: 50, ..Default::default() }).unwrap();
        assert_eq!(names(&one), ["Lightning Bolt"]);

        let eight_plus = run_search(&conn, &SearchRequest { mana_values: Some(vec![8]), limit: 50, ..Default::default() }).unwrap();
        assert_eq!(names(&eight_plus), ["Emrakul"], "8 means 8 or more");

        let either = run_search(&conn, &SearchRequest { mana_values: Some(vec![1, 4]), limit: 50, ..Default::default() }).unwrap();
        assert_eq!(either.total, 2);
    }

    /// A card with no mana value is not a card with a mana value of zero. `NULL IN (…)`
    /// and `NULL >= 8` are both NULL, so this falls out of SQL's own semantics — the test
    /// is here so a later rewrite into `coalesce(cmc, 0)` fails loudly.
    #[test]
    fn a_null_mana_value_matches_no_chip() {
        let conn = seeded_costs();
        for chips in [vec![0u8], vec![8], vec![0, 1, 2, 3, 4, 5, 6, 7, 8]] {
            let r = run_search(&conn, &SearchRequest { mana_values: Some(chips.clone()), limit: 50, ..Default::default() }).unwrap();
            assert!(!names(&r).contains(&"Jinnie Fay"), "chips {chips:?} matched a NULL cmc");
        }
    }

    /// Filters AND, including the new ones, and the capped count has to agree with the
    /// page — they share one `WHERE`, and this is what proves it stays that way.
    #[test]
    fn the_new_filters_combine_with_the_old_ones_and_the_count_agrees() {
        let conn = seeded_costs();
        let r = run_search(
            &conn,
            &SearchRequest {
                sets: Some(vec!["lea".into()]),
                mana_values: Some(vec![1, 4]),
                colors: Some("W".into()),
                format: Some("modern".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(names(&r), ["Wrath of God"]);
        assert_eq!(r.total, 1, "the count subquery must carry the same filters");
    }

    /// A picker whose "clear" state sends `[]` or `[""]` must not become a filter that
    /// matches nothing.
    #[test]
    fn empty_filter_lists_are_not_filters() {
        let conn = seeded_costs();
        let all = run_search(&conn, &SearchRequest { limit: 50, ..Default::default() }).unwrap().total;

        for req in [
            SearchRequest { sets: Some(vec![]), limit: 50, ..Default::default() },
            SearchRequest { sets: Some(vec!["".into(), "  ".into()]), limit: 50, ..Default::default() },
            SearchRequest { mana_values: Some(vec![]), limit: 50, ..Default::default() },
        ] {
            assert_eq!(run_search(&conn, &req).unwrap().total, all);
        }
    }

    /// `invoke` matches by name and serde renames to camelCase; a field the frontend
    /// spells differently deserializes to `None` with no error anywhere.
    #[test]
    fn the_request_deserializes_the_names_the_frontend_sends() {
        let req: SearchRequest = serde_json::from_str(
            r#"{"text":"bolt","sets":["lea","2ed"],"manaValues":[0,8],"paperOnly":true,"limit":50,"offset":0}"#,
        )
        .unwrap();

        assert_eq!(req.sets.unwrap(), vec!["lea".to_owned(), "2ed".to_owned()]);
        assert_eq!(req.mana_values.unwrap(), vec![0u8, 8]);
    }

    /// What the set picker is built from: every set, newest first, with the number of
    /// printings the local database actually holds for it.
    #[test]
    fn list_sets_reports_every_set_newest_first_with_its_card_count() {
        let conn = seeded_costs();
        conn.execute_batch(
            "INSERT INTO sets (code, name, set_type, released_at) VALUES
                ('lea','Limited Edition Alpha','core','1993-08-05'),
                ('roe','Rise of the Eldrazi','expansion','2010-04-23'),
                ('sld','Secret Lair Drop','box','2019-12-02'),
                ('tok','Token Set','token','2021-01-01');",
        )
        .unwrap();

        let sets = run_list_sets(&conn).unwrap();

        assert_eq!(sets.len(), 4);
        assert_eq!(
            sets.iter().map(|s| s.code.as_str()).collect::<Vec<_>>(),
            ["tok", "sld", "roe", "lea"],
            "newest first"
        );
        assert_eq!(sets[3].card_count, 2, "two Alpha printings are in `cards`");
        // A set the local database has no printings for still appears — it is the count
        // that lets the picker decide, not this function.
        assert_eq!(sets[0].card_count, 0);
    }
```

- [ ] **Step 2: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib search
```
Expected: compile errors — `struct SearchRequest has no field named sets`, `cannot find function run_list_sets`.

- [ ] **Step 3: Extend the request** — in `src-tauri/src/search.rs`, add to `SearchRequest` after `set_code`:

```rust
    /// Set codes to include. ORed with each other, ANDed with every other filter — two
    /// sets means "printed in either", which is what a multi-select means everywhere else.
    pub sets: Option<Vec<String>>,
    /// Mana-value chips. 0–7 match `cmc` exactly; [`MANA_VALUE_OPEN_ENDED`] means "or
    /// more". A card with no `cmc` matches none of them.
    pub mana_values: Option<Vec<u8>>,
```

`#[serde(rename_all = "camelCase", default)]` is already on the struct, so these arrive as
`sets` and `manaValues` and default to `None` when omitted. `Default` derives too, which
the tests rely on.

Add the constants beside `COLORS`:

```rust
/// Sets one request will filter on. The picker is a multi-select over ~1 050 sets; past a
/// few dozen the filter has stopped narrowing anything, and this is what bounds the
/// generated placeholder list.
const MAX_SET_FILTER: usize = 64;

/// The last mana-value chip, which is open-ended: "8" means 8 *or more*, because the tail
/// past Emrakul is a handful of cards nobody filters by exact cost.
const MANA_VALUE_OPEN_ENDED: u8 = 8;
```

- [ ] **Step 4: Build the two clauses** — in `run_search`, after the existing `set_code` block:

```rust
    // OR within, AND without. Blank entries are dropped rather than matched: a picker's
    // cleared state sends `[]`, and some send `[""]`.
    if let Some(sets) = req.sets.as_deref() {
        let picked: Vec<String> = sets
            .iter()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .take(MAX_SET_FILTER)
            .collect();
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            wheres.push(format!("c.set_code IN ({holes})"));
            for code in picked {
                params.push(Box::new(code));
            }
        }
    }

    // Discrete chips, not a range: 0–7 are exact and 8 is open-ended. `cmc` is REAL and
    // nullable — a fractional un-card cost matches no chip, and a card with no cost at all
    // matches none either, because `NULL IN (…)` and `NULL >= 8` are both NULL. That is
    // the right answer: "mana value 3" is a claim about a card that has one.
    if let Some(values) = req.mana_values.as_deref() {
        let mut exact: Vec<f64> = Vec::new();
        let mut open_ended = false;
        for v in values {
            if *v >= MANA_VALUE_OPEN_ENDED {
                open_ended = true;
            } else {
                exact.push(f64::from(*v));
            }
        }
        let mut alternatives: Vec<String> = Vec::new();
        if !exact.is_empty() {
            let holes = vec!["?"; exact.len()].join(",");
            alternatives.push(format!("c.cmc IN ({holes})"));
            for v in exact {
                params.push(Box::new(v));
            }
        }
        if open_ended {
            // A constant from the line above, never a request value.
            alternatives.push(format!("c.cmc >= {MANA_VALUE_OPEN_ENDED}.0"));
        }
        if !alternatives.is_empty() {
            wheres.push(format!("({})", alternatives.join(" OR ")));
        }
    }
```

Both clauses go in `wheres` and both push onto `params` **before** the `LIMIT`/`OFFSET`
pushes at the end, so the count subquery — which shares `where_sql` and runs first, while
`params` still holds exactly the filters — picks them up with no further change.

- [ ] **Step 5: Update the module doc, again** — Task 7 corrected it from "three" to "four";
this task adds structure of its own. In `search.rs`'s module comment:

```rust
//! Only four things are ever interpolated into the SQL string — a colour letter from a
//! fixed array, a `FROM` clause picked from two literals, an `ORDER BY` picked from four,
//! and the constant row cap on the count — plus two `?`-placeholder lists whose *length*
//! is the only thing they carry. No user text reaches the parser; everything else is bound.
```

- [ ] **Step 6: Add `list_sets`** — at the end of `search.rs`, before `mod tests`:

```rust
/// One row of the set picker.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetSummary {
    /// Lowercase, as `cards.set_code` stores it — the value the filter sends back.
    pub code: String,
    pub name: String,
    pub set_type: Option<String>,
    pub released_at: Option<String>,
    /// Printings of this set in the local database.
    ///
    /// Not decoration: `sets` carries every set Scryfall knows, including memorabilia and
    /// token-only sets that `default_cards` holds nothing for. A picker over 1 050 rows is
    /// only usable if it can put the ones with cards first, and it needs this to do it.
    pub card_count: i64,
}

/// Every set, newest first, for the search filter's picker.
///
/// One grouped pass over `cards` rather than a correlated count per set: 1 050 subqueries
/// against a 116 k-row table is a visible pause on a control that opens instantly.
pub fn run_list_sets(conn: &Connection) -> Result<Vec<SetSummary>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT s.code, s.name, s.set_type, s.released_at, coalesce(n.cards, 0)
             FROM sets s
             LEFT JOIN (SELECT set_code, count(*) AS cards FROM cards GROUP BY set_code) n
                    ON n.set_code = s.code
             ORDER BY s.released_at DESC, s.name ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(SetSummary {
                code: r.get(0)?,
                name: r.get(1)?,
                set_type: r.get(2)?,
                released_at: r.get(3)?,
                card_count: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// The set list, for the search filter. Read-only connection, blocking pool — as
/// [`search_cards`] is, and for the same reason.
#[tauri::command]
pub async fn list_sets(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<SetSummary>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || run_list_sets(&lock_db_read(&state)))
        .await
        .map_err(|e| format!("set list could not be read: {e}"))?
}
```

- [ ] **Step 7: Register it** — in `src-tauri/src/lib.rs`'s `generate_handler!`, after
`search::search_cards`:

```rust
            search::list_sets,
```

- [ ] **Step 8: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib search
```
Expected: all search tests pass, including the seven new ones. The five pre-existing ones
are untouched — every new field defaults to `None`.

- [ ] **Step 9: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: multi-set and mana-value search filters, plus a list_sets command

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: The filter bar — mana chips, set picker, mana values, Reset all

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** The filter section of that document is a specification, not a suggestion: real mana symbols on authentic fills, pressed = full fill + ring, unpressed = the same chip dimmed, a searchable multi-select set combobox with keyrune glyphs, 0–8+ mana-value chips, and **Reset all** with a count badge whenever a filter is on.

**Files:**
- Create: `src/lib/keyrune.ts`, `src/lib/keyrune.test.ts`, `src/features/search/FilterBar.tsx`, `src/features/search/FilterBar.test.tsx`, `src/features/search/SetCombobox.tsx`, `src/features/search/SetCombobox.test.tsx`, `src/features/search/useCardSearch.test.ts`
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/features/search/useCardSearch.ts`, `src/features/search/SearchPage.tsx`

**Interfaces:**
- Consumes: `MANA_KEYS`, `MANA_LABEL`, `manaSymbolClass` from `@/lib/mana` (Task 8); `SetSummary` and the extended `SearchRequest` from Task 9; `useInfiniteQuery`/`useQuery` from TanStack Query.
- Produces:

```ts
// src/lib/ipc.ts
export interface SetSummary { code: string; name: string; setType: string | null;
                              releasedAt: string | null; cardCount: number }
// SearchRequest gains: sets?: string[]; manaValues?: number[];
// ipc gains: listSets: () => invoke<SetSummary[]>("list_sets")

// src/lib/keyrune.ts
export function setGlyphClass(code: string): string;      // "ss ss-lea"

// src/features/search/useCardSearch.ts
export const MANA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;
export function toggleIn<T>(list: readonly T[], value: T): T[];
export function activeFilterCount(f: FilterState): number;
export type CardSearch = ReturnType<typeof useCardSearch>;
// COLOR_KEYS / COLOR_LABEL / ColorKey become re-exports of mana.ts's MANA_* (Step 5)
// the hook gains: sets, toggleSet, manaValues, toggleManaValue, resetAll, activeCount

// src/features/search/FilterBar.tsx
export function FilterBar({ search }: { search: CardSearch }): JSX.Element;
// src/features/search/SetCombobox.tsx
export function SetCombobox({ selected, onToggle }: {
  selected: readonly string[]; onToggle: (code: string) => void }): JSX.Element;
```

- **One WUBRG vocabulary.** `useCardSearch` currently declares its own `COLOR_KEYS` / `ColorKey` / `COLOR_LABEL`, which are the same six letters in the same order as `mana.ts`'s `MANA_KEYS` / `ManaKey` / `MANA_LABEL`. Step 5 collapses them onto one definition — two lists that must stay identical will not.
- **Colour chips keep subset semantics.** `toggleColor`'s existing rule stands: `C` is exclusive both ways, because the backend reads `colors === "C"` as colourless-only and anything else as subset-of-these-letters, under which `"WC"` would silently mean plain `"W"`. Do not "fix" this while restyling it.

- [ ] **Step 1: Mirror the DTOs** — in `src/lib/ipc.ts`, add to `SearchRequest`:

```ts
  /** Set codes. ORed with each other, ANDed with every other filter. */
  sets?: string[];
  /** Mana-value chips: 0–7 match exactly, 8 means "8 or more". */
  manaValues?: number[];
```

add the summary type:

```ts
/** One row of the set picker. */
export interface SetSummary {
  /** Lowercase, as `cards.set_code` stores it — this is what the filter sends back. */
  code: string;
  name: string;
  setType: string | null;
  releasedAt: string | null;
  /** Printings of this set in the local database; `0` for sets `default_cards` omits. */
  cardCount: number;
}
```

and to the `ipc` object:

```ts
  /** Every set, newest first. Cached for the session — it changes once a sync, at most. */
  listSets: () => invoke<SetSummary[]>("list_sets"),
```

- [ ] **Step 2: Pin the wire shape on both sides** — in `src/lib/ipc.test.ts`, inside the
existing argument-name `describe`:

```ts
  it("sends the new filters under the names Rust deserializes", async () => {
    invoke.mockResolvedValue({ items: [], total: 0, totalIsCapped: false });

    await ipc.searchCards({ sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 });

    // `search.rs` renames to camelCase, so `manaValues` — not `mana_values` — is the
    // spelling that lands in `SearchRequest.mana_values`.
    expect(invoke).toHaveBeenCalledWith("search_cards", {
      req: { sets: ["lea"], manaValues: [1, 8], limit: 50, offset: 0 },
    });
  });

  it("takes no arguments for the set list", async () => {
    invoke.mockResolvedValue([]);
    await ipc.listSets();
    expect(invoke).toHaveBeenCalledWith("list_sets");
  });
```

- [ ] **Step 3: Write the failing helper tests** — create `src/lib/keyrune.test.ts` and
`src/features/search/useCardSearch.test.ts`:

```ts
// src/lib/keyrune.test.ts
import { describe, expect, it } from "vitest";
import { setGlyphClass } from "@/lib/keyrune";

describe("setGlyphClass", () => {
  it("names the keyrune class for a set code", () => {
    expect(setGlyphClass("LEA")).toBe("ss ss-lea");
    expect(setGlyphClass("neo")).toBe("ss ss-neo");
  });

  /**
   * keyrune ships 441 set classes and Scryfall knows ~1 050 sets, so a miss is routine.
   * A missing class has no `::before` content, so the span collapses to nothing — the
   * fallback is built into the font, not into a lookup table this app would have to
   * maintain. Codes with characters no class could have are still refused, so nothing
   * odd reaches a class attribute.
   */
  it("refuses anything that is not a plain set code", () => {
    expect(setGlyphClass("")).toBe("");
    expect(setGlyphClass("a b")).toBe("");
    expect(setGlyphClass("../x")).toBe("");
  });
});
```

```ts
// src/features/search/useCardSearch.test.ts
import { describe, expect, it } from "vitest";
import { activeFilterCount, toggleColor, toggleIn } from "./useCardSearch";

describe("toggleIn", () => {
  it("adds what is missing and removes what is there", () => {
    expect(toggleIn([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggleIn([1, 2], 2)).toEqual([1]);
  });
});

describe("activeFilterCount", () => {
  const none = { text: "", format: "", colors: [], sets: [], manaValues: [] };

  it("is zero when nothing is filtered", () => {
    expect(activeFilterCount(none)).toBe(0);
  });

  /**
   * Each *kind* of filter counts once, however many values it holds: the badge tells the
   * reader how many things Reset all is about to clear, and "3" for three colours in one
   * chip row would be a different, less useful claim.
   */
  it("counts each kind of filter once", () => {
    expect(activeFilterCount({ ...none, colors: ["W", "U", "B"] })).toBe(1);
    expect(activeFilterCount({ ...none, sets: ["lea", "roe"] })).toBe(1);
    expect(activeFilterCount({ ...none, text: "bolt", format: "modern", manaValues: [1] })).toBe(3);
  });

  /** Whitespace is not a search. */
  it("ignores a blank search box", () => {
    expect(activeFilterCount({ ...none, text: "   " })).toBe(0);
  });
});

/** Unchanged behaviour, pinned here because Task 10 restyles the chips it belongs to. */
describe("toggleColor", () => {
  it("keeps C exclusive in both directions", () => {
    expect(toggleColor(["W", "U"], "C")).toEqual(["C"]);
    expect(toggleColor(["C"], "W")).toEqual(["W"]);
  });
});
```

- [ ] **Step 4: Run and watch them fail**

```powershell
npm run test:run -- src/lib/keyrune.test.ts src/features/search/useCardSearch.test.ts
```
Expected: unresolved `@/lib/keyrune`, and `toggleIn`/`activeFilterCount` not exported.

- [ ] **Step 5: Implement the helpers** — create `src/lib/keyrune.ts`:

```ts
/**
 * Set symbols, from the bundled `keyrune` icon font.
 *
 * The class is a pure function of the set code, which is why it is derived here rather
 * than sent by Rust: a CSS class name is presentation, and the data layer has no business
 * knowing one.
 */

/** Set codes are lowercase alphanumerics; anything else is not one and gets no glyph. */
const SET_CODE = /^[a-z0-9]+$/;

/**
 * The `keyrune` classes for a set's symbol, or `""` when there is nothing safe to render.
 *
 * keyrune ships 441 sets and Scryfall knows ~1 050, so a code with no glyph is routine
 * rather than exceptional — and it needs no handling: a class with no `::before` rule
 * renders nothing and occupies nothing. Call sites still show the code as text, so the
 * set is always identifiable with or without its symbol.
 */
export function setGlyphClass(code: string): string {
  const key = code.trim().toLowerCase();
  return SET_CODE.test(key) ? `ss ss-${key}` : "";
}
```

and extend `src/features/search/useCardSearch.ts`. First, collapse the duplicated colour
vocabulary onto `mana.ts` — replace the `COLOR_KEYS`, `ColorKey` and `COLOR_LABEL`
declarations with re-exports, so the chips and the filter can never disagree about what
"the five colours" are or what order they go in:

```ts
// The filter's colours and the interface's mana symbols are the same six letters in the
// same order, and `colorParam` depends on that order to make "U then W" and "W then U"
// the same query key. One definition, re-exported under the name the filter code uses.
export { MANA_KEYS as COLOR_KEYS, MANA_LABEL as COLOR_LABEL } from "@/lib/mana";
export type ColorKey = ManaKey;

/** The whole of what `FilterBar` consumes — named so the component and its test agree. */
export type CardSearch = ReturnType<typeof useCardSearch>;

/** The mana-value chips. The last one is open-ended — see `MANA_VALUE_OPEN_ENDED`. */
export const MANA_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8] as const;

/** Add or remove one value. The order values were picked in is not information. */
export function toggleIn<T>(list: readonly T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

export interface FilterState {
  text: string;
  format: string;
  colors: readonly string[];
  sets: readonly string[];
  manaValues: readonly number[];
}

/**
 * How many *kinds* of filter are on.
 *
 * Kinds, not values: this number captions a Reset all button, and its job is to tell the
 * reader how much is about to change. Three colours in one chip row is one thing that is
 * on, not three.
 */
export function activeFilterCount(f: FilterState): number {
  return [
    f.text.trim().length > 0,
    f.format.length > 0,
    f.colors.length > 0,
    f.sets.length > 0,
    f.manaValues.length > 0,
  ].filter(Boolean).length;
}
```

then add the state and actions inside `useCardSearch`:

```ts
  const [sets, setSets] = useState<readonly string[]>([]);
  const [manaValues, setManaValues] = useState<readonly number[]>([]);
```

```ts
  // Sorted before they reach the key: picking two sets in either order is the same search
  // and must not cost a second round trip.
  const setsParam = sets.length > 0 ? [...sets].sort() : undefined;
  const manaParam = manaValues.length > 0 ? [...manaValues].sort((a, b) => a - b) : undefined;

  const queryKey = [
    "cards",
    "search",
    debouncedText,
    format,
    colorsParam ?? "",
    setsParam?.join(",") ?? "",
    manaParam?.join(",") ?? "",
  ];
```

with `sets: setsParam, manaValues: manaParam` added to the `ipc.searchCards({…})` call, and
returned from the hook:

```ts
    sets,
    toggleSet: (code: string) => setSets((picked) => toggleIn(picked, code)),
    manaValues,
    toggleManaValue: (value: number) => setManaValues((picked) => toggleIn(picked, value)),
    activeCount: activeFilterCount({ text, format, colors, sets, manaValues }),
    /** Clear every filter at once, including the search box. */
    resetAll: () => {
      setText("");
      setFormat("");
      setColors([]);
      setSets([]);
      setManaValues([]);
    },
```

Also extend `unfiltered` — it decides whether an empty result means "the database is empty"
or "nothing matched", and two more filters can now make it wrong:

```ts
    unfiltered: !debouncedText && !format && !colorsParam && !setsParam && !manaParam,
```

- [ ] **Step 6: Run the helper tests**

```powershell
npm run test:run -- src/lib/keyrune.test.ts src/features/search/useCardSearch.test.ts
```
Expected: 7 passed.

- [ ] **Step 7: Write the failing filter-bar tests** — create
`src/features/search/FilterBar.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";

const search = (over: Record<string, unknown> = {}) =>
  ({
    text: "",
    setText: vi.fn(),
    format: "",
    setFormat: vi.fn(),
    colors: [] as string[],
    toggleColor: vi.fn(),
    sets: [] as string[],
    toggleSet: vi.fn(),
    manaValues: [] as number[],
    toggleManaValue: vi.fn(),
    activeCount: 0,
    resetAll: vi.fn(),
    ...over,
  }) as unknown as Parameters<typeof FilterBar>[0]["search"];

vi.mock("./SetCombobox", () => ({
  SetCombobox: () => <div data-testid="set-combobox" />,
}));

describe("FilterBar", () => {
  /**
   * The direction is explicit: real symbols, not letters in circles. The glyph comes from
   * the bundled `mana-font`, so the class is the assertion — a letter `W` rendered as text
   * would pass a text query and be exactly the generic thing this replaced.
   */
  it("draws the colour filter with real mana symbols", () => {
    render(<FilterBar search={search()} />);

    const white = screen.getByRole("button", { name: "White" });
    expect(white.querySelector(".ms.ms-w")).not.toBeNull();
    expect(white).toHaveAttribute("aria-pressed", "false");
    // Colourless is a chip like the others, not an afterthought.
    expect(screen.getByRole("button", { name: "Colorless" }).querySelector(".ms.ms-c")).not.toBeNull();
  });

  it("shows which colours are on", () => {
    render(<FilterBar search={search({ colors: ["U"] })} />);

    expect(screen.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Red" })).toHaveAttribute("aria-pressed", "false");
  });

  it("toggles a colour", async () => {
    const toggleColor = vi.fn();
    render(<FilterBar search={search({ toggleColor })} />);

    await userEvent.click(screen.getByRole("button", { name: "Green" }));

    expect(toggleColor).toHaveBeenCalledWith("G");
  });

  it("offers mana values 0 through 8 or more", async () => {
    const toggleManaValue = vi.fn();
    render(<FilterBar search={search({ toggleManaValue })} />);

    expect(screen.getByRole("button", { name: "Mana value 0" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mana value 8 or more" })).toHaveTextContent("8+");

    await userEvent.click(screen.getByRole("button", { name: "Mana value 3" }));

    expect(toggleManaValue).toHaveBeenCalledWith(3);
  });

  /** Nothing to reset, nothing to say — an always-visible Reset is a control that is
   *  disabled most of the time, which reads as broken. */
  it("hides Reset all until something is filtered", () => {
    render(<FilterBar search={search()} />);

    expect(screen.queryByRole("button", { name: /reset all/i })).not.toBeInTheDocument();
  });

  it("counts what Reset all would clear, and clears it", async () => {
    const resetAll = vi.fn();
    render(<FilterBar search={search({ activeCount: 3, colors: ["W"], resetAll })} />);

    const reset = screen.getByRole("button", { name: /reset all/i });
    expect(reset).toHaveTextContent("3");

    await userEvent.click(reset);

    expect(resetAll).toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run and watch it fail**

```powershell
npm run test:run -- src/features/search/FilterBar.test.tsx
```
Expected: `Failed to resolve import "./FilterBar"`.

- [ ] **Step 9: Implement the filter bar** — create `src/features/search/FilterBar.tsx`:

```tsx
import { RotateCcw } from "lucide-react";
import { MANA_KEYS, MANA_LABEL, manaSymbolClass, type ManaKey } from "@/lib/mana";
import { cn } from "@/lib/utils";
import { SetCombobox } from "./SetCombobox";
import { FORMATS, MANA_VALUES, type CardSearch } from "./useCardSearch";

/**
 * Every filter the search view offers, in one row.
 *
 * The colour chips are the app's one deliberate splash of colour and the reason the rest
 * of the chrome stays grey: a real mana symbol on its authentic printed fill is
 * recognisable at 32px to anyone who has held a card, in a way that a letter in a coloured
 * circle is not. Everything else here is quiet on purpose.
 */
export function FilterBar({ search }: { search: CardSearch }) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label htmlFor="card-search-text" className="sr-only">
        Search cards
      </label>
      <input
        id="card-search-text"
        type="search"
        value={search.text}
        onChange={(e) => search.setText(e.target.value)}
        placeholder="Search cards…"
        className="min-w-56 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
      />

      <div role="group" aria-label="Color identity" className="flex gap-1">
        {MANA_KEYS.map((key) => (
          <ManaChip
            key={key}
            symbol={key}
            pressed={search.colors.includes(key)}
            onClick={() => search.toggleColor(key)}
          />
        ))}
      </div>

      <div role="group" aria-label="Mana value" className="flex gap-1">
        {MANA_VALUES.map((value) => {
          const open = value === MANA_VALUES[MANA_VALUES.length - 1];
          const on = search.manaValues.includes(value);
          return (
            <button
              key={value}
              type="button"
              onClick={() => search.toggleManaValue(value)}
              aria-pressed={on}
              aria-label={open ? `Mana value ${value} or more` : `Mana value ${value}`}
              className={cn(
                "size-8 rounded-md border font-mono text-xs tabular-nums",
                "transition-colors duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                on
                  ? "border-accent text-accent"
                  : "border-border text-muted hover:text-text",
              )}
            >
              {open ? `${value}+` : value}
            </button>
          );
        })}
      </div>

      <SetCombobox selected={search.sets} onToggle={search.toggleSet} />

      <label htmlFor="card-search-format" className="sr-only">
        Format
      </label>
      <select
        id="card-search-format"
        value={search.format}
        onChange={(e) => search.setFormat(e.target.value)}
        className="rounded-md border border-border bg-surface px-2 py-2 text-sm transition-colors duration-150 focus:border-accent focus:outline-none"
      >
        <option value="">Any format</option>
        {FORMATS.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label}
          </option>
        ))}
      </select>

      {/* Only when there is something to clear. A control that spends most of its life
          disabled teaches the reader to stop looking at it. */}
      {search.activeCount > 0 && (
        <button
          type="button"
          onClick={search.resetAll}
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-2 text-sm text-muted transition-colors duration-150 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Reset all
          <span className="rounded-full bg-accent px-1.5 font-mono text-[0.7rem] text-accent-foreground">
            {search.activeCount}
          </span>
        </button>
      )}
    </div>
  );
}

/**
 * One colour chip: the printed symbol, on the printed fill.
 *
 * Pressed is the card's own colour at full strength with a gold ring; unpressed is the
 * same chip dimmed rather than a different chip, so the row reads as one control with
 * some of it switched on — and so a colourblind reader has the symbol's *shape*, which is
 * what Wizards designed it to carry, and not only the hue.
 */
function ManaChip({
  symbol,
  pressed,
  onClick,
}: {
  symbol: ManaKey;
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      aria-label={MANA_LABEL[symbol]}
      title={MANA_LABEL[symbol]}
      style={{ backgroundColor: `var(--color-mana-${symbol.toLowerCase()})` }}
      className={cn(
        "grid size-8 place-items-center rounded-full text-[0.95rem] text-black",
        "transition-[opacity,box-shadow] duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        pressed
          ? "opacity-100 ring-2 ring-accent ring-offset-2 ring-offset-bg"
          : "opacity-40 hover:opacity-70",
      )}
    >
      {/* The glyph itself comes from the bundled `mana-font`; the fill is ours, because
          the font's own `--ms-mana-*` values are a shade off the direction doc's. */}
      <i className={manaSymbolClass(symbol)} aria-hidden="true" />
    </button>
  );
}
```

- [ ] **Step 10: Run it**

```powershell
npm run test:run -- src/features/search/FilterBar.test.tsx
```
Expected: 6 passed.

- [ ] **Step 11: Write the failing combobox test** — create
`src/features/search/SetCombobox.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import type { SetSummary } from "@/lib/ipc";

const listSets = vi.fn();
vi.mock("@/lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/ipc")>()),
  ipc: { listSets },
}));
import { SetCombobox } from "./SetCombobox";

const sets: SetSummary[] = [
  { code: "lea", name: "Limited Edition Alpha", setType: "core", releasedAt: "1993-08-05", cardCount: 295 },
  { code: "neo", name: "Kamigawa: Neon Dynasty", setType: "expansion", releasedAt: "2022-02-18", cardCount: 512 },
  { code: "tok", name: "Token Set", setType: "token", releasedAt: "2021-01-01", cardCount: 0 },
];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SetCombobox", () => {
  it("finds a set by name and by code, and shows its symbol", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    const box = screen.getByRole("textbox", { name: /set/i });

    await userEvent.type(box, "neon");
    expect(await screen.findByRole("option", { name: /Kamigawa: Neon Dynasty/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Alpha/ })).not.toBeInTheDocument();

    await userEvent.clear(box);
    await userEvent.type(box, "lea");
    const alpha = await screen.findByRole("option", { name: /Alpha/ });
    // The keyrune glyph, from the bundled font — a set is recognised by its symbol long
    // before its three-letter code.
    expect(alpha.querySelector(".ss.ss-lea")).not.toBeNull();
  });

  /** `sets` carries every set Scryfall knows, including token-only ones `default_cards`
   *  holds nothing for. A picker full of sets that can never match is a worse picker. */
  it("leaves out sets the local database has no printings for", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));

    expect(await screen.findByRole("option", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Token Set/ })).not.toBeInTheDocument();
  });

  it("picks a set and shows it as picked", async () => {
    listSets.mockResolvedValue(sets);
    const onToggle = vi.fn();
    const { rerender } = wrap(<SetCombobox selected={[]} onToggle={onToggle} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    await userEvent.click(await screen.findByRole("option", { name: /Alpha/ }));
    expect(onToggle).toHaveBeenCalledWith("lea");

    rerender(<SetCombobox selected={["lea"]} onToggle={onToggle} />);
    expect(screen.getByRole("combobox", { name: /set/i })).toHaveTextContent("1 set");
  });

  it("closes on Escape", async () => {
    listSets.mockResolvedValue(sets);
    wrap(<SetCombobox selected={[]} onToggle={vi.fn()} />);

    await userEvent.click(screen.getByRole("combobox", { name: /set/i }));
    expect(await screen.findByRole("listbox")).toBeInTheDocument();

    await userEvent.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 12: Run and watch it fail**

```powershell
npm run test:run -- src/features/search/SetCombobox.test.tsx
```
Expected: `Failed to resolve import "./SetCombobox"`.

- [ ] **Step 13: Implement the combobox** — create `src/features/search/SetCombobox.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { ipc, type SetSummary } from "@/lib/ipc";
import { setGlyphClass } from "@/lib/keyrune";
import { cn } from "@/lib/utils";

/**
 * Options rendered at once.
 *
 * There are ~1 050 sets and the list is filtered as the reader types, so anything past
 * the first screenful is scrolled past rather than read. Capping keeps the popup out of
 * the virtualiser's territory — a 1 050-row `<ul>` inside a dropdown is a jank source for
 * a control that is open for two seconds.
 */
const MAX_OPTIONS = 50;

/**
 * A searchable, multi-select set picker.
 *
 * Hand-rolled rather than pulled from a component library: Radix has no combobox, and the
 * alternative (`cmdk`) is a dependency for one control. The ARIA wiring here is the whole
 * of what that dependency would have provided.
 */
export function SetCombobox({
  selected,
  onToggle,
}: {
  selected: readonly string[];
  onToggle: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // One call per session: the set list changes at most once a sync, and the picker has to
  // open instantly.
  const sets = useQuery({
    queryKey: ["sets"],
    queryFn: () => ipc.listSets(),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (sets.data ?? [])
      // A set with no printings here can never match a search, so offering it is offering
      // an empty result. `sets` holds memorabilia and token-only sets that
      // `default_cards` carries nothing for.
      .filter((s) => s.cardCount > 0)
      .filter((s) => !needle || s.name.toLowerCase().includes(needle) || s.code.includes(needle))
      .slice(0, MAX_OPTIONS);
  }, [sets.data, query]);

  const label =
    selected.length === 0 ? "Any set" : `${selected.length} set${selected.length === 1 ? "" : "s"}`;

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        role="combobox"
        aria-label="Set"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-2 text-sm",
          "transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          selected.length > 0 ? "border-accent text-accent" : "border-border text-muted hover:text-text",
        )}
      >
        {label}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </button>

      {open && (
        <div className="absolute z-20 mt-1 w-72 rounded-md border border-border bg-surface p-2 shadow-lg">
          <input
            ref={inputRef}
            type="search"
            aria-label="Set"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sets…"
            className="mb-2 w-full rounded-md border border-border bg-bg px-2 py-1.5 text-sm placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <ul role="listbox" aria-multiselectable="true" className="max-h-64 overflow-auto">
            {options.length === 0 && (
              <li className="px-2 py-3 text-center text-xs text-muted">
                {sets.isPending ? "Loading sets…" : "No sets match that."}
              </li>
            )}
            {options.map((s) => (
              <Option key={s.code} set={s} picked={selected.includes(s.code)} onToggle={onToggle} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Option({
  set,
  picked,
  onToggle,
}: {
  set: SetSummary;
  picked: boolean;
  onToggle: (code: string) => void;
}) {
  const glyph = setGlyphClass(set.code);
  return (
    <li
      role="option"
      aria-selected={picked}
      tabIndex={0}
      onClick={() => onToggle(set.code)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle(set.code);
        }
      }}
      className={cn(
        "flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors duration-150",
        picked ? "bg-bg text-accent" : "text-text hover:bg-bg/60",
      )}
    >
      {/* keyrune covers 441 of ~1 050 sets; a code it has no glyph for renders nothing at
          all, which is why the code below is always shown as text too. */}
      {glyph && <i className={cn(glyph, "w-4 shrink-0 text-center")} aria-hidden="true" />}
      <span className="min-w-0 flex-1 truncate">{set.name}</span>
      <span className="shrink-0 font-mono text-xs text-muted">{set.code.toUpperCase()}</span>
    </li>
  );
}
```

- [ ] **Step 14: Run it**

```powershell
npm run test:run -- src/features/search/SetCombobox.test.tsx
```
Expected: 4 passed.

- [ ] **Step 15: Swap the filter bar into `SearchPage`** — in
`src/features/search/SearchPage.tsx`, replace the whole inline filter `<div className="flex
flex-wrap items-center gap-3">…</div>` (the search input, format select and colour group)
with `<FilterBar search={search} />`, keeping the view-layout toggle where it is — that is
a display control, not a filter, and belongs beside the results rather than in the filter
row. Delete the now-unused `COLOR_KEYS`/`COLOR_LABEL`/`FORMATS` imports from `SearchPage`.

If `SearchPage.test.tsx` asserts on the format `<select>` or the colour buttons by their
old shape, point those assertions at the new roles (`getByRole("button", { name: "Blue" })`,
`getByLabelText(/format/i)` still works — the label moved to `sr-only` but is still
associated).

- [ ] **Step 16: Verify**

```powershell
npm run verify
```
Expected: green.

- [ ] **Step 17: Manual smoke**

```powershell
npm run tauri dev
```
Expected: five mana symbols plus colourless, drawn as real symbols on their printed fills,
dim until pressed; 0–8+ mana chips in Geist Mono; a set picker that finds "Alpha" by name
and "lea" by code and shows the Alpha symbol; **Reset all** appearing with a count the
moment any filter is on and clearing everything in one click. Combining a colour, a set and
a mana value narrows the results as expected. No external network requests.

- [ ] **Step 18: Commit**

```powershell
git add -A
git commit -m "feat: mana-symbol colour chips, set picker, mana-value chips and Reset all

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
### Task 11: The art-grid view on the search page

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** Two clauses of that document govern this view in particular: *"Card art is the loudest element on any screen that has it; UI must not compete"* — so the tile chrome is a caption and a focus ring, nothing more — and the rarity treatment, which is a **small gem dot or tinted text**, never a filled badge.

The search page currently has one shape: a table. This adds the other one spec §7 asks for — a virtualized grid of 5:7 card frames — and the URL helper every future view will use to name an image.

**Files:**
- Create: `src/lib/images.ts`, `src/lib/images.test.ts`, `src/features/search/CardGrid.tsx`, `src/features/search/CardGrid.test.tsx`
- Modify: `src/lib/store.ts`, `src/features/search/SearchPage.tsx`

**Interfaces:**
- Consumes: `CardSummary { id, name, setCode, setName, collectorNumber, rarity, typeLine, manaCost, priceUsd, layout }` from `src/lib/ipc.ts`; `useCardSearch()` → `{ text, setText, format, setFormat, colors, toggleColor, sets, toggleSet, manaValues, toggleManaValue, activeCount, resetAll, query, rows, searchKey, total, totalIsCapped, unfiltered }` (the last six added in Task 10); `needsNextPage(lastRenderedIndex, loadedCount)`; `rarityColor` from `@/lib/rarity` (Task 8); `useVirtualizer` from `@tanstack/react-virtual`; `cn` from `@/lib/utils`.
- Produces:

```ts
// src/lib/images.ts
export const IMAGE_VARIANTS = ["thumb", "grid", "display", "art"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
/** 5:7, the physical Magic card ratio. Used as a CSS aspect-ratio string. */
export const CARD_ASPECT = "5 / 7";
export function imageOrigin(userAgent: string): string;
export function cardImageUrl(cardId: string, face: number, variant: ImageVariant): string;

// src/lib/store.ts
export type SearchView = "table" | "grid";
// AppState gains: searchView: SearchView; setSearchView: (v: SearchView) => void;

// src/features/search/CardGrid.tsx
export function CardGrid(props: {
  rows: CardSummary[];
  onSelect: (cardId: string) => void;
  onNeedNextPage: () => void;
  searchKey: string;
}): JSX.Element;
```

- Compliance note for the reviewer: these tiles render **full card images** (`grid` variant), which carry the artist's name as printed. The Scryfall artist-credit requirement attaches to `art_crop`/`art` usage, which this view does not use. Do not "optimise" the tile into an art crop without adding the credit line.

- [ ] **Step 1: Write the failing URL tests** — create `src/lib/images.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cardImageUrl, imageOrigin } from "@/lib/images";

/**
 * Tauri serves a custom protocol from a different origin on every platform: Windows and
 * Android get `http://<scheme>.localhost/`, everything else `<scheme>://localhost/`. The
 * app is Windows-first, but the wrong branch is a page of broken images rather than a
 * type error, so both are pinned.
 */
describe("imageOrigin", () => {
  it("uses the http form on Windows", () => {
    expect(imageOrigin("Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2/1.0")).toBe(
      "http://mtgimg.localhost",
    );
  });

  it("uses the scheme form everywhere else", () => {
    expect(imageOrigin("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe(
      "mtgimg://localhost",
    );
  });
});

describe("cardImageUrl", () => {
  it("spells the path the Rust handler parses", () => {
    const url = cardImageUrl("0000419b-0bba-4488-8f7a-6194544ce91d", 0, "grid");

    expect(url).toMatch(/\/grid\/0000419b-0bba-4488-8f7a-6194544ce91d\/0$/);
  });

  it("addresses the back face separately", () => {
    const front = cardImageUrl("ab000000-0000-0000-0000-000000000001", 0, "display");
    const back = cardImageUrl("ab000000-0000-0000-0000-000000000001", 1, "display");

    expect(front).not.toBe(back);
    expect(back).toMatch(/\/1$/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

```powershell
npm run test:run -- src/lib/images.test.ts
```
Expected: `Failed to resolve import "@/lib/images"`.

- [ ] **Step 3: Implement** — create `src/lib/images.ts`:

```ts
/**
 * Naming a card image. The renderer never sees a file path — it asks the `mtgimg://`
 * protocol for `<variant>/<card id>/<face>` and Rust decides where the bytes come from.
 *
 * Written out rather than delegated to `@tauri-apps/api`'s `convertFileSrc`, which reads
 * `window.__TAURI_INTERNALS__` — undefined in jsdom, so every component test that renders
 * a card would throw. The platform rule is two lines and it is pinned by a test.
 */

/** The four WEBP sizes the cache stores. Nothing else exists as far as the UI is aware. */
export const IMAGE_VARIANTS = ["thumb", "grid", "display", "art"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

/**
 * The physical proportions of a Magic card, as a CSS `aspect-ratio`.
 *
 * Every frame that holds a card image uses this — a tile that is not 5:7 either letterboxes
 * the art or stretches it, and stretching a card image is something Scryfall's usage rules
 * forbid outright.
 */
export const CARD_ASPECT = "5 / 7";

/**
 * Where a Tauri custom protocol lives, which is not the same string on every platform:
 * `http://<scheme>.localhost` on Windows and Android, `<scheme>://localhost` elsewhere.
 */
export function imageOrigin(userAgent: string): string {
  return userAgent.includes("Windows") || userAgent.includes("Android")
    ? "http://mtgimg.localhost"
    : "mtgimg://localhost";
}

/**
 * The URL for one face of one printing at one size.
 *
 * `face` is an index, not a side name: 0 is the front, 1 the back. A card with one
 * physical side answers face 1 with a card-back placeholder rather than an error, so a
 * flip control never has to know which layouts have two sides.
 */
export function cardImageUrl(cardId: string, face: number, variant: ImageVariant): string {
  return `${imageOrigin(navigator.userAgent)}/${variant}/${encodeURIComponent(cardId)}/${face}`;
}
```

- [ ] **Step 4: Run the tests**

```powershell
npm run test:run -- src/lib/images.test.ts
```
Expected: 4 passed.

- [ ] **Step 5: Write the failing grid test** — create `src/features/search/CardGrid.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CardSummary } from "@/lib/ipc";
import { CardGrid } from "./CardGrid";

const card = (id: string, name: string): CardSummary => ({
  id,
  name,
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  rarity: "common",
  typeLine: "Instant",
  manaCost: "{R}",
  priceUsd: 400.5,
  layout: "normal",
});

describe("CardGrid", () => {
  it("renders a card image per row, named for the card", () => {
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt"), card("bbb", "Lightning Helix")]}
        onSelect={vi.fn()}
        onNeedNextPage={vi.fn()}
        searchKey="k"
      />,
    );

    const bolt = screen.getByAltText("Lightning Bolt");
    // The alt text is what a screen reader and a failed load both fall back to, so it has
    // to be the card's name rather than "card image".
    expect(bolt).toBeInTheDocument();
    expect(bolt).toHaveAttribute("src", expect.stringContaining("/grid/aaa/0"));
    // Off-screen tiles must not all fetch at once on a 117 k-row browse.
    expect(bolt).toHaveAttribute("loading", "lazy");
  });

  it("opens the card that was clicked", async () => {
    const onSelect = vi.fn();
    render(
      <CardGrid
        rows={[card("aaa", "Lightning Bolt")]}
        onSelect={onSelect}
        onNeedNextPage={vi.fn()}
        searchKey="k"
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /Lightning Bolt/ }));

    expect(onSelect).toHaveBeenCalledWith("aaa");
  });
});
```

jsdom has no layout, so `useVirtualizer` sees a zero-height scroll element and renders
whatever its `overscan` allows. Assert on the data that is present, never on how many
tiles the virtualizer chose to mount.

- [ ] **Step 6: Run and watch it fail**

```powershell
npm run test:run -- src/features/search/CardGrid.test.tsx
```
Expected: `Failed to resolve import "./CardGrid"`.

- [ ] **Step 7: Implement the grid** — create `src/features/search/CardGrid.tsx`:

```tsx
import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import type { CardSummary } from "@/lib/ipc";
import { rarityColor } from "@/lib/rarity";
import { needsNextPage } from "./useCardSearch";

/** Tile width in px. A `grid` image is 488 px wide, so this is a downscale, never a blowup. */
const TILE_WIDTH = 170;
/** Gap between tiles, matching the `gap-3` used elsewhere. */
const GAP = 12;
/** 5:7 plus the caption line under each tile. */
const TILE_HEIGHT = Math.round(TILE_WIDTH * (7 / 5)) + 22;

/**
 * How many tiles fit across `width`.
 *
 * At least one, always: a container measured at 0 (jsdom, or the frame before layout
 * settles) would otherwise divide the row count by zero and hand the virtualizer
 * `Infinity` rows.
 */
export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + GAP) / (TILE_WIDTH + GAP)));
}

/**
 * Search results as card art.
 *
 * Virtualised by *row*, not by tile: the virtualizer measures a list, and a grid is a
 * list of rows that each hold `columns` cards. An unfiltered browse is ~117 k cards, so
 * the alternative is 117 k DOM nodes.
 *
 * The tiles are full card images (the `grid` variant), which is also what keeps this view
 * inside Scryfall's image policy without a separate credit line: the artist's name is
 * printed on the card. An art crop here would need one.
 */
export function CardGrid({
  rows,
  onSelect,
  onNeedNextPage,
  searchKey,
}: {
  rows: CardSummary[];
  onSelect: (cardId: string) => void;
  onNeedNextPage: () => void;
  searchKey: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  // The column count is a function of the container, and a window resize changes it
  // without any scroll or render this component would otherwise hear about.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const columns = columnsFor(width);
  const rowCount = Math.ceil(rows.length / columns);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => TILE_HEIGHT + GAP,
    // Two rows of tiles beyond the viewport, which is the prefetch: their `<img>`s mount
    // and the protocol fills the cache before the reader scrolls onto them.
    overscan: 2,
  });

  const virtualRows = virtualizer.getVirtualItems();
  const lastRendered = virtualRows.length
    ? Math.min(rows.length - 1, (virtualRows[virtualRows.length - 1].index + 1) * columns - 1)
    : -1;

  // A new search reuses this scroll container, and a browser clamps the old offset into
  // the new content rather than resetting it.
  useEffect(() => {
    virtualizer.scrollToOffset(0);
  }, [searchKey, virtualizer]);

  useEffect(() => {
    if (needsNextPage(lastRendered, rows.length)) onNeedNextPage();
  }, [lastRendered, rows.length, onNeedNextPage]);

  return (
    <div
      ref={scrollRef}
      tabIndex={0}
      aria-label="Search results"
      className="min-h-0 flex-1 overflow-auto rounded-md border border-border p-3"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualRows.map((v) => (
          <div
            key={v.key}
            className="absolute inset-x-0 top-0 flex gap-3"
            style={{ height: TILE_HEIGHT, transform: `translateY(${v.start}px)` }}
          >
            {rows.slice(v.index * columns, v.index * columns + columns).map((card, i) => (
              <Tile key={`${v.index}-${i}`} card={card} onSelect={onSelect} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Tile({ card, onSelect }: { card: CardSummary; onSelect: (id: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(card.id)}
      style={{ width: TILE_WIDTH }}
      className="group flex shrink-0 flex-col gap-1 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <img
        // The name, not "card image": this string is what a screen reader announces and
        // what shows when a fetch fails, and both readers want the card.
        alt={card.name}
        src={cardImageUrl(card.id, 0, "grid")}
        // 117 k results is 117 k requests if every mounted tile fetches eagerly. The
        // virtualizer bounds the DOM; this bounds what the DOM asks for.
        loading="lazy"
        decoding="async"
        style={{ aspectRatio: CARD_ASPECT }}
        className="w-full rounded-lg bg-surface object-cover transition-transform group-hover:scale-[1.02]"
      />
      <span className="flex items-center gap-1.5 truncate font-mono text-xs text-muted">
        {/* The rarity gem: 6px of colour, and the only colour in the tile chrome. A filled
            badge here would compete with the art, which the direction forbids outright. */}
        <span
          aria-hidden="true"
          title={card.rarity ?? undefined}
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: rarityColor(card.rarity) }}
        />
        <span className="truncate">
          {card.setCode.toUpperCase()} · {card.collectorNumber}
        </span>
      </span>
    </button>
  );
}
```

- [ ] **Step 8: Run the grid tests**

```powershell
npm run test:run -- src/features/search/CardGrid.test.tsx
```
Expected: 2 passed. If the virtualizer mounts zero rows under jsdom, give the test a
`ResizeObserver` stub in `src/test-setup.ts`:

```ts
// jsdom has no layout engine and no ResizeObserver. The grid measures its container to
// decide how many columns fit, so without this every grid test renders nothing.
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;
```

- [ ] **Step 9: Add the view toggle to the store** — in `src/lib/store.ts`:

```ts
/** How the search results are laid out. */
export type SearchView = "table" | "grid";
```

and inside `AppState` / the `create` call:

```ts
  searchView: SearchView;
  setSearchView: (view: SearchView) => void;
```
```ts
  // Art by default: this is a card app, and the table is the view you switch to when you
  // are comparing prices rather than looking at cards.
  searchView: "grid",
  setSearchView: (searchView) => set({ searchView }),
```

- [ ] **Step 10: Wire the toggle into `SearchPage`** — in `src/features/search/SearchPage.tsx`:

1. Import `useAppStore`, `CardGrid`, and `LayoutGrid`/`Rows3` from `lucide-react`.
2. Read `const view = useAppStore((s) => s.searchView);` and `setSearchView`.
3. Add to the filter bar, after the colour group:

```tsx
        <div role="group" aria-label="Result layout" className="ml-auto flex gap-1">
          {(
            [
              { id: "grid", label: "Card view", Icon: LayoutGrid },
              { id: "table", label: "Table view", Icon: Rows3 },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setSearchView(id)}
              aria-pressed={view === id}
              aria-label={label}
              title={label}
              className={cn(
                "size-9 rounded-md border transition-colors",
                view === id
                  ? "border-accent text-accent"
                  : "border-border text-muted hover:text-text",
              )}
            >
              <Icon className="mx-auto size-4" aria-hidden="true" />
            </button>
          ))}
        </div>
```

4. In `Results`, branch on the view where the table markup begins — the summary line, the
   error banner and the empty state are shared and stay outside the branch. `Results`
   reads `view` from the store itself (`useAppStore((s) => s.searchView)`) rather than
   taking a fifth prop; the table's `useVirtualizer` stays in `SearchPage` and is simply
   unused while the grid is showing, which costs one idle hook and keeps the scroll
   position of each view intact when the reader toggles back:

```tsx
      {!empty &&
        (view === "grid" ? (
          <CardGrid
            rows={rows}
            searchKey={search.searchKey}
            onSelect={selectCard}
            onNeedNextPage={() => {
              if (query.hasNextPage && !query.isFetchingNextPage && !query.isFetchNextPageError) {
                void query.fetchNextPage();
              }
            }}
          />
        ) : (
          /* …the existing table markup, unchanged… */
        ))}
```

`selectCard` is `useAppStore((s) => s.setSelectedCardId)`, added in Task 13; until then
pass `() => {}` and leave a `// Task 13` marker.

The table branch keeps its own paging effect; the grid drives paging through
`onNeedNextPage` because its "last rendered index" is a row of tiles, not a row of data.

- [ ] **Step 11: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: art-grid view for search results with lazy-loaded card images

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Card detail and printings commands

Two read-only commands, shaped like `search_cards`: pure functions over a `Connection` with a thin `#[tauri::command]` wrapper that runs them on the blocking pool against `db_read`. Grouping by illustration and per-finish pricing are **not** here — that is domain logic, and CLAUDE.md puts domain logic in TypeScript.

**Files:**
- Create: `src-tauri/src/card.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod card;` + `generate_handler!`)

**Interfaces:**
- Consumes: `sync::{lock_db_read, AppState}`, the `cards` table, `tauri::async_runtime::spawn_blocking`.
- Produces (serde `camelCase` on the wire, mirroring `search::CardSummary`'s conventions):

```rust
pub struct CardFace {
    pub name: String, pub type_line: Option<String>, pub oracle_text: Option<String>,
    pub mana_cost: Option<String>, pub artist: Option<String>,
}
pub struct CardDetail {
    pub id: String, pub oracle_id: Option<String>, pub name: String,
    pub set_code: String, pub set_name: Option<String>, pub collector_number: String,
    pub rarity: Option<String>, pub layout: String, pub lang: String,
    pub mana_cost: Option<String>, pub cmc: Option<f64>, pub type_line: Option<String>,
    pub oracle_text: Option<String>, pub illustration_id: Option<String>,
    pub artist: Option<String>, pub released_at: Option<String>,
    /// Raw JSON strings, parsed by the frontend — 23 legality keys that grow over time and
    /// six price keys that are decimal strings, neither of which belongs in fixed fields.
    pub legalities: Option<String>, pub prices: Option<String>, pub finishes: Option<String>,
    pub image_status: Option<String>, pub faces: Vec<CardFace>,
}
pub struct Printing {
    pub id: String, pub set_code: String, pub set_name: Option<String>,
    pub collector_number: String, pub released_at: Option<String>, pub rarity: Option<String>,
    pub illustration_id: Option<String>, pub artist: Option<String>, pub lang: String,
    pub finishes: Option<String>, pub prices: Option<String>,
    pub promo: bool, pub full_art: bool, pub frame_effects: Option<String>,
    pub border_color: Option<String>, pub layout: String,
}

pub fn get_card(conn: &Connection, id: &str) -> Result<Option<CardDetail>, String>;
pub fn list_printings(conn: &Connection, oracle_id: &str) -> Result<Vec<Printing>, String>;

#[tauri::command] pub async fn card_detail(state, id: String) -> Result<Option<CardDetail>, String>;
#[tauri::command] pub async fn card_printings(state, oracle_id: String) -> Result<Vec<Printing>, String>;
```

- `artist` has no column: it is read with `coalesce(json_extract(raw,'$.artist'), json_extract(faces,'$[0].artist'))`. It is required by the image policy on the detail pane, and a column for it would be a v3 migration for one string.
- `list_printings` is capped and ordered; `idx_cards_oracle` serves the lookup.

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/card.rs` with only this test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    /// Three printings of one oracle card — two sharing an illustration, one with its own
    /// — plus a double-faced card, which is the shape `faces` has to survive.
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows = [
            ("p1", "o1", "lea", "161", "1993-08-05", "art-a"),
            ("p2", "o1", "2ed", "162", "1993-12-01", "art-a"),
            ("p3", "o1", "m10", "146", "2009-07-17", "art-b"),
        ];
        for (id, oracle, set, cn, released, illus) in rows {
            conn.execute(
                "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                    released_at, illustration_id, rarity, type_line, oracle_text, mana_cost,
                    legalities, finishes, prices, search_text, raw)
                 VALUES (?1, ?2, 'Lightning Bolt', ?3, ?4, 'en', 'normal', ?5, ?6, 'common',
                    'Instant', 'Lightning Bolt deals 3 damage to any target.', '{R}',
                    '{\"modern\":\"legal\",\"vintage\":\"restricted\",\"standard\":\"not_legal\"}',
                    '[\"nonfoil\",\"foil\"]',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\",\"usd_etched\":null,\"eur\":\"4.20\",\"eur_foil\":\"35.00\",\"tix\":\"0.03\"}',
                    'Lightning Bolt', json_object('artist','Christopher Rush'))",
                rusqlite::params![id, oracle, set, cn, released, illus],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO cards (id, oracle_id, name, set_code, collector_number, lang, layout,
                faces, search_text, raw)
             VALUES ('dfc','o2','Delver of Secrets // Insectile Aberration','isd','51','en',
                'transform',
                json_array(
                  json_object('name','Delver of Secrets','type_line','Creature — Human Wizard',
                              'oracle_text','At the beginning of your upkeep…',
                              'mana_cost','{U}','artist','Nils Hamm'),
                  json_object('name','Insectile Aberration','type_line','Creature — Human Insect',
                              'oracle_text','Flying','mana_cost','','artist','Nils Hamm')),
                'Delver', '{}')",
            [],
        )
        .unwrap();
        conn
    }

    #[test]
    fn a_card_comes_back_with_the_blobs_the_ui_parses() {
        let conn = seeded();
        let c = get_card(&conn, "p1").unwrap().unwrap();

        assert_eq!(c.name, "Lightning Bolt");
        assert_eq!(c.set_code, "lea");
        assert_eq!(c.oracle_id.as_deref(), Some("o1"));
        // Blobs, not fields: legalities has 23 keys and grows, prices are decimal strings.
        assert!(c.legalities.as_deref().unwrap().contains("\"vintage\""));
        assert!(c.prices.as_deref().unwrap().contains("usd_foil"));
        // No column for it; the image policy needs it on this pane.
        assert_eq!(c.artist.as_deref(), Some("Christopher Rush"));
        assert!(c.faces.is_empty(), "a single-faced card has no faces");
    }

    /// The faces a flip control needs, in order, with the artist per face — `card_faces`
    /// carries its own artist and a DFC's two sides are not always the same illustrator.
    #[test]
    fn a_double_faced_card_carries_both_faces_in_order() {
        let conn = seeded();
        let c = get_card(&conn, "dfc").unwrap().unwrap();

        assert_eq!(c.faces.len(), 2);
        assert_eq!(c.faces[0].name, "Delver of Secrets");
        assert_eq!(c.faces[1].name, "Insectile Aberration");
        assert_eq!(c.faces[1].artist.as_deref(), Some("Nils Hamm"));
    }

    #[test]
    fn an_unknown_id_is_none_not_an_error() {
        let conn = seeded();
        assert!(get_card(&conn, "nope").unwrap().is_none());
    }

    /// Every printing of the oracle card, newest first — the order a "which printing do I
    /// own" list wants, and the one that puts the reprint someone just opened at the top.
    #[test]
    fn printings_come_back_newest_first_with_their_art_identity() {
        let conn = seeded();
        let all = list_printings(&conn, "o1").unwrap();

        assert_eq!(all.len(), 3);
        assert_eq!(all[0].set_code, "m10", "newest first");
        assert_eq!(all[2].set_code, "lea");
        // Grouping by illustration is the frontend's job, but the field it groups on has
        // to arrive — two of these share an illustration and one does not.
        assert_eq!(all[0].illustration_id.as_deref(), Some("art-b"));
        assert_eq!(all[1].illustration_id.as_deref(), Some("art-a"));
        // Per-finish pricing reads the blob, never `price_usd`.
        assert!(all[0].prices.as_deref().unwrap().contains("usd_etched"));
        assert!(all[0].finishes.as_deref().unwrap().contains("foil"));
    }

    /// `oracle_id` is NULLABLE — reversible cards have none at all. An empty list, not a
    /// query that matches every row whose oracle_id is also null.
    #[test]
    fn an_unknown_oracle_id_returns_nothing() {
        let conn = seeded();
        assert!(list_printings(&conn, "").unwrap().is_empty());
        assert!(list_printings(&conn, "o-none").unwrap().is_empty());
    }
}
```

- [ ] **Step 2: Run and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib card
```
Expected: `cannot find function 'get_card'` — after adding `pub mod card;` to `lib.rs`.

- [ ] **Step 3: Implement** — write the rest of `src-tauri/src/card.rs`:

```rust
//! One printing in full, and every printing of the same oracle card.
//!
//! Shaped exactly like [`crate::search`]: pure functions over a `Connection` so they are
//! testable without a Tauri app, wrapped in `async` commands that run on the blocking
//! pool against the **read-only** connection.
//!
//! What is deliberately *not* computed here: grouping printings by `illustration_id`, and
//! turning the `prices` blob into a per-finish figure. Both are domain logic, and
//! CLAUDE.md puts domain logic in TypeScript where the tests are fast — Rust hands over
//! the JSON and the frontend decides what it means.

use crate::sync::{lock_db_read, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::sync::Arc;

/// Printings returned for one oracle card. The most-reprinted cards in Magic have a few
/// hundred; the cap is a bound on a pane, not a pager.
const MAX_PRINTINGS: usize = 400;

/// `artist` has no column of its own — it is one string, and a v3 migration for it would
/// cost more than reading it back out of the JSON already stored. The face fallback
/// matters: on a reversible card there is no top-level artist.
const ARTIST_SQL: &str =
    "coalesce(json_extract(raw, '$.artist'), json_extract(faces, '$[0].artist'))";

/// One physical side of a card, for the flip control and the credit line.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardFace {
    pub name: String,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub mana_cost: Option<String>,
    /// Per face: a double-faced card's two sides are not always the same illustrator.
    pub artist: Option<String>,
}

/// Everything the detail pane renders about the printing in front of the reader.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDetail {
    pub id: String,
    pub oracle_id: Option<String>,
    pub name: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub rarity: Option<String>,
    pub layout: String,
    pub lang: String,
    pub mana_cost: Option<String>,
    pub cmc: Option<f64>,
    pub type_line: Option<String>,
    pub oracle_text: Option<String>,
    pub illustration_id: Option<String>,
    /// Required by Scryfall's image policy wherever art is shown.
    pub artist: Option<String>,
    pub released_at: Option<String>,
    /// JSON, verbatim. 23 keys today and the set grows — the day this becomes columns is
    /// the day a new format needs a migration.
    pub legalities: Option<String>,
    /// JSON, verbatim. Six keys, decimal **strings**; a finish price is a lookup in here,
    /// never `price_usd` (which is a display fallback chain and would price a nonfoil at
    /// foil rates).
    pub prices: Option<String>,
    pub finishes: Option<String>,
    pub image_status: Option<String>,
    /// Empty for a single-faced card.
    pub faces: Vec<CardFace>,
}

/// One row of the printings list.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Printing {
    pub id: String,
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub released_at: Option<String>,
    pub rarity: Option<String>,
    /// What "alternate art" is actually keyed on: two printings differ in art iff this
    /// differs. `variation` is true on 0.09% of cards and is no help at all.
    pub illustration_id: Option<String>,
    pub artist: Option<String>,
    pub lang: String,
    pub finishes: Option<String>,
    pub prices: Option<String>,
    pub promo: bool,
    pub full_art: bool,
    pub frame_effects: Option<String>,
    pub border_color: Option<String>,
    pub layout: String,
}

/// One printing by id, or `None` if there is no such row.
pub fn get_card(conn: &Connection, id: &str) -> Result<Option<CardDetail>, String> {
    let sql = format!(
        "SELECT id, oracle_id, name, set_code, set_name, collector_number, rarity, layout, lang,
                mana_cost, cmc, type_line, oracle_text, illustration_id, {ARTIST_SQL},
                released_at, legalities, prices, finishes, image_status, faces
         FROM cards WHERE id = ?1"
    );
    conn.query_row(&sql, params![id], |r| {
        let faces: Option<String> = r.get(20)?;
        Ok(CardDetail {
            id: r.get(0)?,
            oracle_id: r.get(1)?,
            name: r.get(2)?,
            set_code: r.get(3)?,
            set_name: r.get(4)?,
            collector_number: r.get(5)?,
            rarity: r.get(6)?,
            layout: r.get(7)?,
            lang: r.get(8)?,
            mana_cost: r.get(9)?,
            cmc: r.get(10)?,
            type_line: r.get(11)?,
            oracle_text: r.get(12)?,
            illustration_id: r.get(13)?,
            artist: r.get(14)?,
            released_at: r.get(15)?,
            legalities: r.get(16)?,
            prices: r.get(17)?,
            finishes: r.get(18)?,
            image_status: r.get(19)?,
            faces: parse_faces(faces.as_deref()),
        })
    })
    .optional()
    .map_err(|e| e.to_string())
}

/// `card_faces` as the pane needs it. A blob that will not parse yields no faces rather
/// than an error: a card with unreadable face data is still a card worth showing.
fn parse_faces(json: Option<&str>) -> Vec<CardFace> {
    let Some(value) = json.and_then(|j| serde_json::from_str::<serde_json::Value>(j).ok()) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|faces| {
            faces
                .iter()
                .filter_map(|f| {
                    Some(CardFace {
                        name: f.get("name")?.as_str()?.to_owned(),
                        type_line: str_field(f, "type_line"),
                        oracle_text: str_field(f, "oracle_text"),
                        // Present but empty on a transform's back, which is not the same
                        // as absent and should not render as a cost of `{}`.
                        mana_cost: str_field(f, "mana_cost").filter(|s| !s.is_empty()),
                        artist: str_field(f, "artist"),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_owned)
}

/// Every printing of one oracle card, newest first.
///
/// A blank `oracle_id` returns nothing rather than matching: `oracle_id` is NULLABLE
/// (reversible cards have none), and a query that let `''` through would be one `IS NULL`
/// away from returning every such card in the database as a "printing" of each other.
pub fn list_printings(conn: &Connection, oracle_id: &str) -> Result<Vec<Printing>, String> {
    if oracle_id.trim().is_empty() {
        return Ok(Vec::new());
    }
    let sql = format!(
        "SELECT id, set_code, set_name, collector_number, released_at, rarity, illustration_id,
                {ARTIST_SQL}, lang, finishes, prices, promo, full_art, frame_effects,
                border_color, layout
         FROM cards WHERE oracle_id = ?1
         ORDER BY released_at DESC, set_code ASC, collector_number ASC, id ASC
         LIMIT ?2"
    );
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![oracle_id, MAX_PRINTINGS as i64], |r| {
            Ok(Printing {
                id: r.get(0)?,
                set_code: r.get(1)?,
                set_name: r.get(2)?,
                collector_number: r.get(3)?,
                released_at: r.get(4)?,
                rarity: r.get(5)?,
                illustration_id: r.get(6)?,
                artist: r.get(7)?,
                lang: r.get(8)?,
                finishes: r.get(9)?,
                prices: r.get(10)?,
                promo: r.get(11)?,
                full_art: r.get(12)?,
                frame_effects: r.get(13)?,
                border_color: r.get(14)?,
                layout: r.get(15)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// One printing in full. Read-only connection, blocking pool — see [`crate::search::search_cards`].
#[tauri::command]
pub async fn card_detail(
    state: tauri::State<'_, Arc<AppState>>,
    id: String,
) -> Result<Option<CardDetail>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || get_card(&lock_db_read(&state), &id))
        .await
        .map_err(|e| format!("card could not be read: {e}"))?
}

/// Every printing of one oracle card. Read-only connection, blocking pool.
#[tauri::command]
pub async fn card_printings(
    state: tauri::State<'_, Arc<AppState>>,
    oracle_id: String,
) -> Result<Vec<Printing>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_printings(&lock_db_read(&state), &oracle_id))
        .await
        .map_err(|e| format!("printings could not be read: {e}"))?
}
```

- [ ] **Step 4: Register the commands** — in `src-tauri/src/lib.rs`:

```rust
        .invoke_handler(tauri::generate_handler![
            sync_run,
            sync_status,
            search::search_cards,
            card::card_detail,
            card::card_printings
        ])
```

- [ ] **Step 5: Run the tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib card
```
Expected: five passed.

- [ ] **Step 6: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: card detail and printings-by-oracle-id commands through the read connection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: The card detail pane

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** Four of its rules land here: Geist **Mono** for collector numbers, prices and counts (with `tabular-nums`); rarity as a **gem dot or tinted text**, never a filled badge; Cinzel for section headers **only** and never below 18px — the card's *name* is content, so it stays in Geist; and the artist/copyright line is set in the muted text colour at the pane's foot, legible but never competing with the art above it.

Spec §7's "card detail pane": the `display` image with a face flip, every printing grouped by illustration with per-finish prices, legality chips, and the artist and copyright line the image policy requires. The grouping and pricing are pure TypeScript with their own tests — that is the CLAUDE.md boundary in practice.

**Files:**
- Create: `src/features/card/printings.ts`, `src/features/card/printings.test.ts`, `src/features/card/CardDetailPane.tsx`, `src/features/card/CardDetailPane.test.tsx`
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/store.ts`, `src/App.tsx`, `src/features/search/SearchPage.tsx`

**Interfaces:**
- Consumes: the Rust DTOs from Task 12 (field names must match `rename_all = "camelCase"` exactly), `cardImageUrl` / `CARD_ASPECT` (Task 11), `useQuery` from TanStack Query, `queryClient` from `@/lib/query`.
- Produces:

```ts
// src/lib/ipc.ts
export interface CardFace { name: string; typeLine: string | null; oracleText: string | null;
                            manaCost: string | null; artist: string | null }
export interface CardDetail { /* every field of Rust's CardDetail, camelCased */ }
export interface Printing { /* every field of Rust's Printing, camelCased */ }
// ipc gains: cardDetail(id), cardPrintings(oracleId)

// src/features/card/printings.ts
export type Finish = "nonfoil" | "foil" | "etched";
export interface ArtGroup { illustrationId: string | null; printings: Printing[] }
export function groupByIllustration(printings: Printing[]): ArtGroup[];
export function parseFinishes(json: string | null): Finish[];
export function finishPrice(pricesJson: string | null, finish: Finish): number | null;
export function legalityChips(legalitiesJson: string | null): { format: string; status: string }[];
export function faceCount(layout: string, faces: number): number;

// src/lib/store.ts — AppState gains
selectedCardId: string | null;
setSelectedCardId: (id: string | null) => void;
```

- [ ] **Step 1: Add the DTOs** — in `src/lib/ipc.ts`, after `SearchResponse`:

```ts
/** One physical side of a card. Empty for single-faced printings. */
export interface CardFace {
  name: string;
  typeLine: string | null;
  oracleText: string | null;
  /** Absent *and* empty both mean "no cost" — a transform's back sends `""`. */
  manaCost: string | null;
  artist: string | null;
}

/** Everything the detail pane renders about one printing. */
export interface CardDetail {
  id: string;
  oracleId: string | null;
  name: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  rarity: string | null;
  layout: string;
  lang: string;
  manaCost: string | null;
  cmc: number | null;
  typeLine: string | null;
  oracleText: string | null;
  illustrationId: string | null;
  /** Required by Scryfall's image policy wherever art is shown. */
  artist: string | null;
  releasedAt: string | null;
  /** JSON: 23 legality keys and growing. Parse it, never index fixed fields. */
  legalities: string | null;
  /** JSON: six keys, decimal **strings**. A finish price is a lookup in here. */
  prices: string | null;
  finishes: string | null;
  imageStatus: string | null;
  faces: CardFace[];
}

/** One row of the "all printings" list. */
export interface Printing {
  id: string;
  setCode: string;
  setName: string | null;
  collectorNumber: string;
  releasedAt: string | null;
  rarity: string | null;
  /** Two printings differ in *art* iff this differs. `variation` is 0.09% true and useless. */
  illustrationId: string | null;
  artist: string | null;
  lang: string;
  finishes: string | null;
  prices: string | null;
  promo: boolean;
  fullArt: boolean;
  frameEffects: string | null;
  borderColor: string | null;
  layout: string;
}
```

and to the `ipc` object:

```ts
  cardDetail: (id: string) => invoke<CardDetail | null>("card_detail", { id }),
  /** Every printing of the oracle card, newest first. */
  cardPrintings: (oracleId: string) => invoke<Printing[]>("card_printings", { oracleId }),
```

- [ ] **Step 2: Pin the argument names** — in `src/lib/ipc.test.ts`, inside the existing
`describe("ipc argument names match the Rust command signatures", …)`:

```ts
  it("sends a card id under `id` and an oracle id under `oracleId`", async () => {
    invoke.mockResolvedValue(null);
    await ipc.cardDetail("p1");
    expect(invoke).toHaveBeenCalledWith("card_detail", { id: "p1" });

    invoke.mockResolvedValue([]);
    await ipc.cardPrintings("o1");
    // Tauri maps a camelCase key onto the `oracle_id` parameter; spelling it
    // `oracle_id` here would be the runtime deserialization error no type can catch.
    expect(invoke).toHaveBeenCalledWith("card_printings", { oracleId: "o1" });
  });
```

- [ ] **Step 3: Write the failing domain tests** — create `src/features/card/printings.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { Printing } from "@/lib/ipc";
import {
  faceCount,
  finishPrice,
  groupByIllustration,
  legalityChips,
  parseFinishes,
} from "./printings";

const printing = (over: Partial<Printing>): Printing => ({
  id: "p",
  setCode: "lea",
  setName: "Limited Edition Alpha",
  collectorNumber: "161",
  releasedAt: "1993-08-05",
  rarity: "common",
  illustrationId: "art-a",
  artist: "Christopher Rush",
  lang: "en",
  finishes: '["nonfoil"]',
  prices: '{"usd":"5.00","usd_foil":null,"usd_etched":null,"eur":"4.20","eur_foil":null,"tix":"0.03"}',
  promo: false,
  fullArt: false,
  frameEffects: null,
  borderColor: "black",
  layout: "normal",
  ...over,
});

describe("groupByIllustration", () => {
  it("puts printings that share artwork together, in first-seen order", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: "art-b" }),
      printing({ id: "b", illustrationId: "art-a" }),
      printing({ id: "c", illustrationId: "art-b" }),
    ]);

    expect(groups.map((g) => g.illustrationId)).toEqual(["art-b", "art-a"]);
    expect(groups[0].printings.map((p) => p.id)).toEqual(["a", "c"]);
  });

  /**
   * "Newly spoiled cards may not have this field yet", so a null illustration is a real
   * case. Every one of them is its own group: lumping them together would claim a set of
   * unrelated cards share artwork.
   */
  it("never merges printings that have no illustration id", () => {
    const groups = groupByIllustration([
      printing({ id: "a", illustrationId: null }),
      printing({ id: "b", illustrationId: null }),
    ]);

    expect(groups).toHaveLength(2);
  });
});

describe("finishPrice", () => {
  /**
   * The carryover's sharpest warning: `price_usd` is a display fallback chain
   * (nonfoil→foil→etched) and would price a nonfoil at foil rates. A finish price is a
   * lookup by finish in the blob, and nothing else.
   */
  it("reads the key that belongs to the finish", () => {
    const prices =
      '{"usd":"5.00","usd_foil":"40.00","usd_etched":"71.50","eur":"4.20","eur_foil":null,"tix":"0.03"}';

    expect(finishPrice(prices, "nonfoil")).toBe(5);
    expect(finishPrice(prices, "foil")).toBe(40);
    expect(finishPrice(prices, "etched")).toBe(71.5);
  });

  it("is null when that finish has no price, and never falls back to another one", () => {
    const prices =
      '{"usd":null,"usd_foil":null,"usd_etched":"0.71","eur":null,"eur_foil":null,"tix":null}';

    expect(finishPrice(prices, "nonfoil")).toBeNull();
    expect(finishPrice(prices, "foil")).toBeNull();
    expect(finishPrice(prices, "etched")).toBe(0.71);
  });

  it("survives an absent or unparseable blob", () => {
    expect(finishPrice(null, "foil")).toBeNull();
    expect(finishPrice("not json", "foil")).toBeNull();
  });
});

describe("parseFinishes", () => {
  it("reads the enum, and etched is one of its values", () => {
    expect(parseFinishes('["nonfoil","foil","etched"]')).toEqual(["nonfoil", "foil", "etched"]);
  });

  it("drops anything that is not a finish, and tolerates nothing at all", () => {
    expect(parseFinishes('["nonfoil","glossy"]')).toEqual(["nonfoil"]);
    expect(parseFinishes(null)).toEqual([]);
    expect(parseFinishes("{}")).toEqual([]);
  });
});

describe("legalityChips", () => {
  it("shows only the formats the card is playable or banned in, in a fixed order", () => {
    const chips = legalityChips(
      '{"modern":"legal","standard":"not_legal","vintage":"restricted","commander":"banned"}',
    );

    expect(chips).toEqual([
      { format: "modern", status: "legal" },
      { format: "vintage", status: "restricted" },
      { format: "commander", status: "banned" },
    ]);
  });

  /** The key set GROWS — `tlr` is newer than most published field lists. An unknown key
   *  is rendered at the end, never dropped. */
  it("keeps a format it has never heard of", () => {
    const chips = legalityChips('{"modern":"legal","newformat":"legal"}');

    expect(chips.map((c) => c.format)).toEqual(["modern", "newformat"]);
  });

  it("survives an absent blob", () => {
    expect(legalityChips(null)).toEqual([]);
  });
});

describe("faceCount", () => {
  it("counts two sides only for the layouts that physically have them", () => {
    expect(faceCount("transform", 2)).toBe(2);
    expect(faceCount("modal_dfc", 2)).toBe(2);
    expect(faceCount("reversible_card", 2)).toBe(2);
    // Two faces, one physical side: the back of a split card is a normal Magic back.
    expect(faceCount("split", 2)).toBe(1);
    expect(faceCount("adventure", 2)).toBe(1);
    expect(faceCount("flip", 2)).toBe(1);
    // `meld` has top-level images and no `card_faces` at all.
    expect(faceCount("meld", 0)).toBe(1);
    expect(faceCount("normal", 0)).toBe(1);
  });
});
```

- [ ] **Step 4: Run and watch them fail**

```powershell
npm run test:run -- src/features/card/printings.test.ts
```
Expected: `Failed to resolve import "./printings"`.

- [ ] **Step 5: Implement the domain module** — create `src/features/card/printings.ts`:

```ts
/**
 * The card-detail domain logic: which printings share artwork, what a finish costs, and
 * which formats are worth a chip.
 *
 * Here rather than in Rust because CLAUDE.md puts domain logic in TypeScript — and
 * because every rule below is a judgement call about meaning (is a null illustration a
 * group? does a missing foil price fall back?) that wants fast tests around it.
 */
import type { Printing } from "@/lib/ipc";

/** Scryfall's finish enum. Never a boolean — `etched` is a third thing. */
export type Finish = "nonfoil" | "foil" | "etched";
const FINISHES: readonly Finish[] = ["nonfoil", "foil", "etched"];

/** The `prices` key each finish is worth. */
const PRICE_KEY: Record<Finish, string> = {
  nonfoil: "usd",
  foil: "usd_foil",
  etched: "usd_etched",
};

/**
 * The 23 legality keys in Scryfall's emission order.
 *
 * A display order, not a schema: the set grows (`tlr` is newer than most published field
 * lists, and `timeless`/`predh`/`oathbreaker` were all added over time), so anything not
 * in this list is rendered after it rather than dropped.
 */
export const FORMAT_ORDER = [
  "standard", "future", "historic", "timeless", "gladiator", "pioneer", "modern", "legacy",
  "pauper", "vintage", "penny", "commander", "oathbreaker", "standardbrawl", "brawl",
  "competitivebrawl", "alchemy", "paupercommander", "duel", "oldschool", "premodern",
  "predh", "tlr",
] as const;

/** Layouts whose `card_faces` are two *physical* sides. */
const TWO_SIDED = new Set([
  "transform",
  "modal_dfc",
  "double_faced_token",
  "reversible_card",
  "art_series",
]);

/** Printings that share one illustration. */
export interface ArtGroup {
  illustrationId: string | null;
  printings: Printing[];
}

/**
 * Group printings by artwork, preserving the order they arrived in (newest first).
 *
 * Two printings differ in art iff `illustration_id` differs — `variation` is true on
 * 0.09% of cards and finds nothing. A **null** illustration is never grouped with another
 * null: the field is documented as missing on newly spoiled cards, so merging them would
 * claim a set of unrelated printings share an artwork.
 */
export function groupByIllustration(printings: Printing[]): ArtGroup[] {
  const groups: ArtGroup[] = [];
  const byId = new Map<string, ArtGroup>();
  for (const p of printings) {
    const existing = p.illustrationId === null ? undefined : byId.get(p.illustrationId);
    if (existing) {
      existing.printings.push(p);
      continue;
    }
    const group: ArtGroup = { illustrationId: p.illustrationId, printings: [p] };
    if (p.illustrationId !== null) byId.set(p.illustrationId, group);
    groups.push(group);
  }
  return groups;
}

/** The finishes a printing exists in. Unknown values are dropped, not guessed at. */
export function parseFinishes(json: string | null): Finish[] {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f): f is Finish => FINISHES.includes(f as Finish));
}

/**
 * What one finish of this printing costs in USD, or `null`.
 *
 * A lookup by finish, with **no fallback of any kind**. `price_usd` — the derived column
 * — is a nonfoil→foil→etched chain built for sorting, and using it here would price a
 * plain copy at foil rates. Values arrive as decimal strings because money is not a
 * float on the wire; `Number` is the last possible moment to make one.
 */
export function finishPrice(pricesJson: string | null, finish: Finish): number | null {
  const prices = safeParse(pricesJson);
  if (typeof prices !== "object" || prices === null) return null;
  const raw = (prices as Record<string, unknown>)[PRICE_KEY[finish]];
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * The formats worth showing, in `FORMAT_ORDER`, with unknown keys last.
 *
 * `not_legal` is dropped: a card is not legal in most of 23 formats, and 20 grey chips
 * bury the three that carry information.
 */
export function legalityChips(
  legalitiesJson: string | null,
): { format: string; status: string }[] {
  const parsed = safeParse(legalitiesJson);
  if (typeof parsed !== "object" || parsed === null) return [];
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    ([, status]) => typeof status === "string" && status !== "not_legal",
  ) as [string, string][];

  const rank = (format: string) => {
    const i = FORMAT_ORDER.indexOf(format as (typeof FORMAT_ORDER)[number]);
    return i === -1 ? FORMAT_ORDER.length : i;
  };
  return entries
    .sort((a, b) => rank(a[0]) - rank(b[0]))
    .map(([format, status]) => ({ format, status }));
}

/**
 * How many physical sides this printing has.
 *
 * Not the length of `card_faces`: `split`, `adventure`, `flip` and `prepare` all have two
 * faces printed on one side of one piece of cardboard, and offering to flip them would
 * show a card back. `meld` has no `card_faces` at all.
 */
export function faceCount(layout: string, faces: number): number {
  return TWO_SIDED.has(layout) && faces >= 2 ? 2 : 1;
}

function safeParse(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Run the domain tests**

```powershell
npm run test:run -- src/features/card/printings.test.ts
```
Expected: 12 passed.

- [ ] **Step 7: Write the failing pane test** — create `src/features/card/CardDetailPane.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { CardDetail, Printing } from "@/lib/ipc";

const detail: CardDetail = {
  id: "p1",
  oracleId: "o1",
  name: "Delver of Secrets // Insectile Aberration",
  setCode: "isd",
  setName: "Innistrad",
  collectorNumber: "51",
  rarity: "common",
  layout: "transform",
  lang: "en",
  manaCost: "{U}",
  cmc: 1,
  typeLine: "Creature — Human Wizard",
  oracleText: "At the beginning of your upkeep…",
  illustrationId: "art-a",
  artist: "Nils Hamm",
  releasedAt: "2011-09-30",
  legalities: '{"modern":"legal","standard":"not_legal"}',
  prices: '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
  finishes: '["nonfoil","foil"]',
  imageStatus: "highres_scan",
  faces: [
    { name: "Delver of Secrets", typeLine: "Creature — Human Wizard", oracleText: "…", manaCost: "{U}", artist: "Nils Hamm" },
    { name: "Insectile Aberration", typeLine: "Creature — Human Insect", oracleText: "Flying", manaCost: null, artist: "Nils Hamm" },
  ],
};

const printings: Printing[] = [
  { id: "p1", setCode: "isd", setName: "Innistrad", collectorNumber: "51", releasedAt: "2011-09-30",
    rarity: "common", illustrationId: "art-a", artist: "Nils Hamm", lang: "en",
    finishes: '["nonfoil","foil"]',
    prices: '{"usd":"0.50","usd_foil":"3.00","usd_etched":null,"eur":null,"eur_foil":null,"tix":null}',
    promo: false, fullArt: false, frameEffects: null, borderColor: "black", layout: "transform" },
];

const cardDetail = vi.fn();
const cardPrintings = vi.fn();
vi.mock("@/lib/ipc", async (original) => ({
  ...(await original<typeof import("@/lib/ipc")>()),
  ipc: { cardDetail: (id: string) => cardDetail(id), cardPrintings: (o: string) => cardPrintings(o) },
}));
import { CardDetailPane } from "./CardDetailPane";

function wrap(cardId: string, onClose = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CardDetailPane cardId={cardId} onClose={onClose} />
    </QueryClientProvider>,
  );
}

describe("CardDetailPane", () => {
  it("shows the card, its artist and the required copyright line", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(printings);

    wrap("p1");

    expect(await screen.findByText("Delver of Secrets // Insectile Aberration")).toBeInTheDocument();
    // Scryfall's image policy: the artist and the source have to be identifiable in the
    // same interface that shows the art. Deleting either line is a policy violation, not
    // a style change.
    expect(screen.getByText(/Nils Hamm/)).toBeInTheDocument();
    expect(
      screen.getByText(/Card images © Wizards of the Coast · Data © Scryfall/),
    ).toBeInTheDocument();
  });

  it("flips a double-faced card to the back image", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(printings);

    wrap("p1");
    const flip = await screen.findByRole("button", { name: /flip/i });
    expect(screen.getByAltText(/Delver of Secrets/)).toHaveAttribute(
      "src",
      expect.stringContaining("/display/p1/0"),
    );

    await userEvent.click(flip);

    await waitFor(() =>
      expect(screen.getByAltText(/Insectile Aberration/)).toHaveAttribute(
        "src",
        expect.stringContaining("/display/p1/1"),
      ),
    );
  });

  it("prices each finish from its own key", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(printings);

    wrap("p1");

    // $0.50 nonfoil and $3.00 foil, never one number for both.
    expect(await screen.findByText(/\$0\.50/)).toBeInTheDocument();
    expect(screen.getByText(/\$3\.00/)).toBeInTheDocument();
  });

  it("shows a legality chip for modern and none for standard", async () => {
    cardDetail.mockResolvedValue(detail);
    cardPrintings.mockResolvedValue(printings);

    wrap("p1");

    expect(await screen.findByText("modern")).toBeInTheDocument();
    expect(screen.queryByText("standard")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 8: Run and watch it fail**

```powershell
npm run test:run -- src/features/card/CardDetailPane.test.tsx
```
Expected: `Failed to resolve import "./CardDetailPane"`.

- [ ] **Step 9: Implement the pane** — create `src/features/card/CardDetailPane.tsx`:

```tsx
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { CARD_ASPECT, cardImageUrl } from "@/lib/images";
import { ipc, ipcError, type CardDetail, type Printing } from "@/lib/ipc";
import { rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";
import {
  faceCount,
  finishPrice,
  groupByIllustration,
  legalityChips,
  parseFinishes,
  type Finish,
} from "./printings";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched",
};

const STATUS_CLASS: Record<string, string> = {
  legal: "border-accent/50 text-accent",
  restricted: "border-border text-text",
  banned: "border-destructive/50 text-destructive",
};

/**
 * One printing, in full: the card itself, every printing of the same oracle card grouped
 * by artwork, and the credit the image policy requires.
 *
 * A docked pane rather than a modal. The results list behind it stays live and reachable,
 * so there is nothing to trap focus into and nothing to mark `aria-modal` — a dialog that
 * claims the page behind it is inert while it demonstrably is not is worse for a screen
 * reader than no dialog at all.
 */
export function CardDetailPane({
  cardId,
  onClose,
}: {
  cardId: string;
  onClose: () => void;
}) {
  const [face, setFace] = useState(0);

  // A different card is a different card, and the back of the last one is not where a
  // reader wants to arrive.
  useEffect(() => setFace(0), [cardId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const card = useQuery({
    queryKey: ["card", cardId],
    queryFn: () => ipc.cardDetail(cardId),
  });

  const oracleId = card.data?.oracleId ?? null;
  const printings = useQuery({
    queryKey: ["card", "printings", oracleId],
    queryFn: () => ipc.cardPrintings(oracleId as string),
    // A reversible card has no `oracle_id` at all, so there is nothing to ask for.
    enabled: oracleId !== null,
  });

  return (
    <aside
      aria-label="Card details"
      className="flex w-96 shrink-0 flex-col gap-4 overflow-auto border-l border-border bg-surface p-4"
    >
      <div className="flex items-start gap-2">
        {/* The card's name is content, not a section header, so it stays in Geist —
            Cinzel is for view titles and hero copy, and never below 18px. */}
        <h2 className="min-w-0 flex-1 text-base font-medium">
          {card.data?.name ?? (card.isPending ? "Loading…" : "Card")}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close card details"
          className="shrink-0 rounded-md border border-border p-1 text-muted transition-colors hover:text-text"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {card.isError && (
        <p role="alert" className="text-sm text-destructive">
          {ipcError(card.error)}
        </p>
      )}

      {card.data && (
        <>
          <Art card={card.data} face={face} onFlip={() => setFace((f) => (f === 0 ? 1 : 0))} />
          <Facts card={card.data} />
          <Legalities card={card.data} />
          <Printings
            printings={printings.data ?? []}
            currentId={card.data.id}
            loading={printings.isPending && oracleId !== null}
          />
          {/* Not decoration and not optional: Scryfall requires the artist and the source
              to be identifiable in the same interface that shows the art. */}
          <p className="border-t border-border pt-3 text-[0.7rem] leading-relaxed text-muted">
            {card.data.artist && <>Illustrated by {card.data.artist}. </>}
            Card images © Wizards of the Coast · Data © Scryfall
          </p>
        </>
      )}
    </aside>
  );
}

function Art({
  card,
  face,
  onFlip,
}: {
  card: CardDetail;
  face: number;
  onFlip: () => void;
}) {
  const sides = faceCount(card.layout, card.faces.length);
  const shown = card.faces[face];
  return (
    <div className="space-y-2">
      <img
        alt={shown?.name ?? card.name}
        src={cardImageUrl(card.id, face, "display")}
        style={{ aspectRatio: CARD_ASPECT }}
        // No filters, no transforms: distorting, cropping or recolouring a card image is
        // forbidden by the usage rules, and `object-cover` on a 5:7 frame holding a 5:7
        // image is a no-op that stays safe if the frame ever changes.
        className="w-full rounded-xl bg-bg object-cover"
      />
      {sides === 2 && (
        <button
          type="button"
          onClick={onFlip}
          className="w-full rounded-md border border-border py-1.5 text-xs text-muted transition-colors hover:text-text"
        >
          Flip to {card.faces[face === 0 ? 1 : 0]?.name ?? "other face"}
        </button>
      )}
    </div>
  );
}

function Facts({ card }: { card: CardDetail }) {
  const finishes = parseFinishes(card.finishes);
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted">
        {card.typeLine ?? "—"}
        {card.manaCost && <span className="ml-2 text-xs">{card.manaCost}</span>}
      </p>
      <p className="text-xs text-muted">
        <span className="font-mono">
          {card.setName ?? card.setCode.toUpperCase()} · #{card.collectorNumber}
        </span>
        {/* Rarity as tinted text rather than a filled badge — the direction budgets colour
            for mana and art, and a rarity is a footnote. */}
        {card.rarity && (
          <>
            {" · "}
            <span className="capitalize" style={{ color: rarityColor(card.rarity) }}>
              {card.rarity}
            </span>
          </>
        )}
      </p>
      {card.oracleText && <p className="whitespace-pre-line text-xs">{card.oracleText}</p>}
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {finishes.map((f) => (
          <div key={f} className="flex gap-1">
            <dt className="text-muted">{FINISH_LABEL[f]}</dt>
            <dd className="font-mono tabular-nums">{price(finishPrice(card.prices, f))}</dd>
          </div>
        ))}
      </dl>
      {/* Spec §5: prices are always labelled with an as-of date. */}
      <p className="text-[0.7rem] text-muted">Prices as of the last card-data sync.</p>
    </div>
  );
}

function Legalities({ card }: { card: CardDetail }) {
  const chips = legalityChips(card.legalities);
  if (chips.length === 0) return null;
  return (
    <ul aria-label="Format legality" className="flex flex-wrap gap-1">
      {chips.map(({ format, status }) => (
        <li
          key={format}
          title={status}
          className={cn(
            "rounded-full border px-2 py-0.5 text-[0.7rem] capitalize",
            STATUS_CLASS[status] ?? "border-border text-muted",
          )}
        >
          {format}
        </li>
      ))}
    </ul>
  );
}

function Printings({
  printings,
  currentId,
  loading,
}: {
  printings: Printing[];
  currentId: string;
  loading: boolean;
}) {
  if (loading) return <p className="text-xs text-muted">Loading printings…</p>;
  if (printings.length === 0) return null;

  const groups = groupByIllustration(printings);
  return (
    <section className="space-y-2">
      <h3 className="text-xs uppercase tracking-wide text-muted">
        {printings.length} printing{printings.length === 1 ? "" : "s"} ·{" "}
        {groups.length} artwork{groups.length === 1 ? "" : "s"}
      </h3>
      {groups.map((group, i) => (
        <div key={group.illustrationId ?? `ungrouped-${i}`} className="space-y-1">
          <ul className="space-y-1">
            {group.printings.map((p) => (
              <li
                key={p.id}
                className={cn(
                  "flex items-baseline gap-2 rounded-md px-2 py-1 text-xs",
                  p.id === currentId ? "bg-bg text-text" : "text-muted",
                )}
              >
                <span className="min-w-0 flex-1 truncate font-mono">
                  {p.setCode.toUpperCase()} · {p.collectorNumber}
                  {p.releasedAt && <> · {p.releasedAt.slice(0, 4)}</>}
                </span>
                {/* Per finish, from the blob — never one number standing for both. */}
                {parseFinishes(p.finishes).map((f) => (
                  <span key={f} className="shrink-0 font-mono tabular-nums" title={FINISH_LABEL[f]}>
                    {price(finishPrice(p.prices, f))}
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function price(value: number | null): string {
  return value === null ? "—" : usd.format(value);
}
```

- [ ] **Step 10: Run the pane tests**

```powershell
npm run test:run -- src/features/card
```
Expected: 16 passed.

- [ ] **Step 11: Mount it** — three edits:

1. `src/lib/store.ts`, inside `AppState` and the `create` call:

```ts
  /** The printing the detail pane is showing, or `null` when it is closed. */
  selectedCardId: string | null;
  setSelectedCardId: (id: string | null) => void;
```
```ts
  selectedCardId: null,
  setSelectedCardId: (selectedCardId) => set({ selectedCardId }),
```

2. `src/features/search/SearchPage.tsx`: replace the Task 11 `// Task 13` marker with
   `const selectCard = useAppStore((s) => s.setSelectedCardId);` and make the **table**
   rows selectable too — the row `<div>` gains `onClick={() => selectCard(card.id)}`, plus
   `tabIndex={0}` and `onKeyDown` for Enter/Space so the table is not mouse-only.

3. `src/App.tsx`: render the pane beside the active view.

```tsx
function ActiveView() { /* …unchanged… */ }

export default function App() {
  const selectedCardId = useAppStore((s) => s.selectedCardId);
  const setSelectedCardId = useAppStore((s) => s.setSelectedCardId);

  return (
    <QueryClientProvider client={queryClient}>
      <AppShell>
        <div className="flex h-full min-h-0 gap-4">
          <div className="min-w-0 flex-1">
            <ActiveView />
          </div>
          {selectedCardId && (
            <CardDetailPane
              cardId={selectedCardId}
              onClose={() => setSelectedCardId(null)}
            />
          )}
        </div>
      </AppShell>
    </QueryClientProvider>
  );
}
```

- [ ] **Step 12: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: card detail pane with face flip, printings by artwork, per-finish prices

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: Page prefetch, full verify, manual smoke, plan wrap

The grid's overscan already mounts two rows of off-screen `<img>` tags, which fills the
cache for the next scroll. This adds the other half: when a page of results lands, tell
Rust to warm the images for it, so the first paint of a newly-fetched page is not a wall
of empty frames.

**Files:**
- Modify: `src-tauri/src/images.rs` (`prefetch_images` command), `src-tauri/src/lib.rs` (registration), `src/lib/ipc.ts`, `src/features/search/SearchPage.tsx`, `CLAUDE.md`, this plan file

**Interfaces:**
- Consumes: `images::{Cache, ImageKey, Variant}`, `AppState`, `ipc` from `src/lib/ipc.ts`.
- Produces:

```rust
#[tauri::command]
pub async fn prefetch_images(
    state: tauri::State<'_, Arc<AppState>>,
    card_ids: Vec<String>,
    variant: String,
) -> Result<(), String>;
```
```ts
prefetchImages: (cardIds: string[], variant: ImageVariant) =>
  invoke<void>("prefetch_images", { cardIds, variant }),
```

- Explicitly **not** here: the full collection pre-warm from spec §5. There are no
  collection, wishlist or deck tables yet — Plan 3 creates them, and a resumable job with
  nothing to enumerate is a job that cannot be written. Deferred to Plan 3.

- [ ] **Step 1: Write the failing test** — in `images.rs`'s `mod tests`:

```rust
    /// A page of results is 50 cards, and a prefetch that a fast scroll can queue without
    /// bound is a prefetch that fights the images the reader is actually looking at.
    #[test]
    fn a_prefetch_batch_is_capped() {
        let ids: Vec<String> = (0..500)
            .map(|i| format!("{i:08}-0000-0000-0000-000000000000"))
            .collect();

        let keys = prefetch_keys(&ids, Variant::Grid);

        assert_eq!(keys.len(), MAX_PREFETCH);
        assert_eq!(keys[0].face, 0, "only the front is worth prefetching");
        assert_eq!(keys[0].variant, Variant::Grid);
    }

    #[test]
    fn a_prefetch_batch_drops_ids_that_are_not_card_ids() {
        let keys = prefetch_keys(
            &[
                "0000419b-0bba-4488-8f7a-6194544ce91d".to_owned(),
                "../../etc/passwd".to_owned(),
            ],
            Variant::Thumb,
        );

        assert_eq!(keys.len(), 1);
    }
```

- [ ] **Step 2: Run and watch it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib images
```
Expected: `cannot find function 'prefetch_keys'`.

- [ ] **Step 3: Implement** — in `src-tauri/src/images.rs`:

```rust
/// Images one prefetch call will warm. Two pages of results; past that a fast scroll
/// queues work that competes with the tiles the reader is actually looking at.
const MAX_PREFETCH: usize = 100;

/// The keys a prefetch request turns into, validated exactly as a protocol request is.
pub fn prefetch_keys(card_ids: &[String], variant: Variant) -> Vec<ImageKey> {
    card_ids
        .iter()
        .filter(|id| is_card_id(id))
        // Front faces only: the back of a double-faced card is not on screen until
        // someone opens the detail pane and flips it.
        .map(|id| ImageKey {
            card_id: id.clone(),
            face: 0,
            variant,
        })
        .take(MAX_PREFETCH)
        .collect()
}

/// Warm the cache for a page of results.
///
/// Returns as soon as the work is queued rather than when it is done: nothing is waiting
/// on the answer, and a command that took the length of 100 downloads to resolve would be
/// a command the UI has to manage. Failures are silent for the same reason — an image
/// that did not prefetch is an image that fetches when it is rendered.
#[tauri::command]
pub async fn prefetch_images(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
    card_ids: Vec<String>,
    variant: String,
) -> Result<(), String> {
    let Some(variant) = Variant::parse(&variant) else {
        return Err(format!("unknown image variant: {variant}"));
    };
    let state = state.inner().clone();
    let keys = prefetch_keys(&card_ids, variant);
    tauri::async_runtime::spawn(async move {
        for key in keys {
            // The cache's own semaphore and interval gate do the pacing; this loop just
            // hands it work. A failure here is not worth reporting: the tile will ask
            // again when it renders.
            let _ = state
                .images
                .get(&state.client, &state.db_read, &state.db, &key)
                .await;
        }
    });
    Ok(())
}
```

- [ ] **Step 4: Register and expose it**

`src-tauri/src/lib.rs`:

```rust
            card::card_printings,
            images::prefetch_images
```

`src/lib/ipc.ts` — import the variant type and add to the `ipc` object:

```ts
  /**
   * Warm the image cache for a page of results. Fire-and-forget: it resolves as soon as
   * the work is queued, and an image that fails to prefetch simply fetches when it is
   * rendered.
   */
  prefetchImages: (cardIds: string[], variant: ImageVariant) =>
    invoke<void>("prefetch_images", { cardIds, variant }),
```

- [ ] **Step 5: Call it when a page lands** — in `src/features/search/SearchPage.tsx`:

```tsx
  // Warm the images for whatever just arrived. Keyed on the page count rather than on
  // `rows`, so re-renders that do not add a page cost nothing, and only in the grid view
  // — the table shows no art to warm.
  const pageCount = query.data?.pages.length ?? 0;
  useEffect(() => {
    if (view !== "grid" || rows.length === 0) return;
    const latest = query.data?.pages[pageCount - 1]?.items ?? [];
    if (latest.length > 0) {
      void ipc.prefetchImages(latest.map((c) => c.id), "grid").catch(() => {});
    }
    // `query.data` is deliberately out of the dependency list: `pageCount` is the part
    // that means "a page arrived", and depending on the object would re-fire on every
    // background refetch of data the cache already has.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageCount, view]);
```

- [ ] **Step 6: Run the full verify**

```powershell
npm run verify
```
Expected: all four stages green. Fix anything that is not before going on.

- [ ] **Step 7: Manual smoke** (requires an interactive run)

```powershell
npm run tauri dev
```

Check each of these and record the result in the commit message:

| | expected |
|---|---|
| Ribbon | 48px `bg-surface` row: gold "MTG" mark, view title in Cinzel, status line, **Refresh data**; the 2px WUBRG mana line sits under it and nowhere else |
| Mana line during a sync | dims and fills left→right behind a gold cap; with `prefers-reduced-motion` forced on (devtools → Rendering → Emulate CSS media feature), no sweep and no spin, but the state is still legible |
| Filters | mana chips are real symbols on printed fills, dim until pressed; set picker finds "Alpha" by name and "lea" by code with its symbol; 0–8+ chips in mono; **Reset all** shows a count and clears everything |
| Filter combination | a colour + a set + a mana value narrows the results, and the count above the list agrees with what is listed |
| Grid view | opens on card art; tiles fill in as they scroll into view; no layout jump; the rarity gem is a 6px dot, not a badge |
| Fonts and symbols | devtools network panel shows **zero** requests to any external host — Cinzel, Geist Mono, `mana-font` and `keyrune` all come from the app origin |
| 1024px width | shrink the window to its `minWidth`: the ribbon, filter bar and grid all still work, nothing overflows horizontally |
| Devtools console | zero CSP violations; no 4xx/5xx on `mtgimg` requests except for cards you know have no art |
| Cache on disk | `src-tauri/target/debug/data/images/grid/<xx>/…webp` files appear; `SELECT count(*) FROM image_cache` climbs with them |
| Scroll a long browse | images keep up; the app stays responsive (the pacer is 6 in flight, 100 ms apart) |
| Double-faced card | search "Delver of Secrets", open it, Flip shows the Aberration side |
| A card with no art | search a recent art-series printing; a "No image" placeholder tile, not a broken frame |
| Card detail | printings list groups reprints that share art; nonfoil and foil prices differ; legality chips show only playable/banned formats; artist and copyright line present |
| Table view | toggle still works; rows open the same pane |
| Refresh | header numbers stay live *during* the sync instead of blanking (the `db_read` change) |
| Second launch | focuses the first window |
| Quit mid-sync | the window closes promptly; console prints the skipped-checkpoint line rather than hanging |

- [ ] **Step 8: Record the measurements** — append a short table to this plan file under a
`**Smoke result (2026-08-04)**` heading, in the shape Plan 1 used: cold-grid scroll time
for the first screenful, `data/images` size and file count after browsing ~500 cards, and
the observed `image_cache` row count. These are the baselines Plan 3's pre-warm job will
be sized against.

- [ ] **Step 9: Check off every box in this plan and commit**

```powershell
git add -A
git commit -m "chore: complete plan 2 (images & card browsing)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Carryover ledger

Every MUST-DO from `docs/superpowers/notes/plan-1-carryover.md`, and where it went.

| Carryover item | Landed |
|---|---|
| Tighten `csp: null` before the image protocol | **Task 1** |
| `image_uris` needs a real column, via a v2 migration (v1 frozen) | **Task 2** |
| 162 printings with no images → placeholder path | **Task 2** (columns stay NULL), **Task 5** (`Placeholder::NoImage`) |
| Route image-protocol DB reads through `db_read` | **Task 5** (`resolve`), **Task 6** (`serve`) |
| Route `sync::status` through `db_read`, delete the `mergeStatus` special case | **Task 7** |
| `mergeStatus` carries `lastIngestSkipped` | **Task 7** |
| Any `UPDATE cards` outside ingest → FTS rebuild only if indexed columns; prefer a separate table for image state | **Task 2** (`image_cache` is that table; the backfill test is the evidence) |
| Sets pagination A→B→A cycle guard (page cap) | **Task 4** |
| Two-instance collision → single-instance guard | **Task 1** |
| Error taxonomy: `RateLimited` flattens to a string; real 30 s 429 backoff | **Task 4** (`RateLimited { retry_after_secs }`, `NotFound`), **Task 5** (the gate pays the penalty), **Task 6** (503 + `Retry-After`) |
| Exit checkpoint blocks on the write mutex → bounded try_lock retry | **Task 7** (`db::lock_for`, added in Task 5) |
| Doc drift: duplicated FTS paragraph, "four fields", "three interpolations" | **Task 7** |
| Deep-OFFSET paging at 595 ms @ 100k → keyset pagination if the grid pages hard | **Deferred, unchanged.** The grid pages the same `search_cards` the table already does, at the same offsets, so Plan 2 changes nothing about the measurement. Task 14's smoke is where it would show; if it does, keyset paging is a `search.rs` change and belongs with the other search work. |
| Full collection/wishlist/deck image pre-warm (spec §5) | **Deferred to Plan 3.** There are no collection, wishlist or deck tables yet — a resumable job has nothing to enumerate. Task 14 ships the visible-page prefetch, which is the part that has data today. |
| Image cache pruning / "clear cache" control | **Deferred to Plan 6** (settings + distribution). The cache is capped in practice by what the user browses (~1.1 GB worst case for `thumb`), deleting `data/images` is already safe by design, and a button to do it belongs with the rest of the settings screen. |

### Visual direction coverage (`2026-08-04-visual-design-direction.md`, binding)

| Direction | Landed |
|---|---|
| Palette tokens: mana fills, pie deeps, rarity | **Task 8** (`src/index.css` `@theme`) |
| Type: Cinzel display 500/600, Geist body, Geist Mono data | **Task 8** (tokens + `--font-heading`), applied in **10**, **11**, **13** |
| The mana line — always present, never repeated, doubles as the sync sweep, gold cap, reduced-motion respected | **Task 8** (`ManaLine`) |
| Global ribbon owns Refresh + sync status; filters stay with their view | **Task 8** (`Ribbon`, `AppShell` restructure) |
| Sidebar gold active indicator | **Task 8** |
| Colour filter: real `mana-font` symbols on authentic fills, C included, pressed = full fill + ring | **Task 10** |
| Set filter: searchable multi-select with `keyrune` glyphs | **Tasks 9 + 10** (`list_sets`, `SetCombobox`) |
| Mana-value chips 0–7 and 8+, multi-select, mono numerals | **Tasks 9 + 10** |
| Format filter restyled | **Task 10** |
| All filters combine; **Reset all** with a count badge when ≥1 is active | **Tasks 9 + 10** |
| Rarity as a gem dot or tinted text, never a badge | **Task 8** (`rarity.ts`), used in **11** and **13** |
| Card art is the loudest element; UI must not compete | **Task 11** (tile chrome is a caption and a focus ring) |
| Motion budget: 150 ms transitions, the sweep, nothing else; `prefers-reduced-motion` honoured | **Task 8**, checked in **Task 14**'s smoke |
| Quality floor: gold focus ring, AA contrast, works at 1024px | every UI task; the width and reduced-motion checks are in **Task 14**'s smoke |
| Symbol/display fonts bundled, never a CDN | **Task 8** (npm + Vite), enforced by **Task 1**'s CSP test and checked in **Task 14**'s smoke |


---

## Later plans (not in this document)

3. **Collection & wishlist** — user tables (soft `card_id` references, denormalized
   `set_code`/`collector_number`/`lang`), entry editor (finish/condition/qty), collection
   and wishlist views, value stats read per-finish from the `prices` blob, migrations
   reconciler, and the **resumable image pre-warm job** for everything the user owns.
4. **Deckbuilder & validation** — deck CRUD, zones, drag-and-drop, `format_specs` seeding,
   the full TS validation engine (restricted semantics, singleton exceptions,
   commanders/partners/companions, colour identity), Commander bracket estimate (needs a
   `game_changer: true` fixture, which has none today).
5. **Import/export** — CSV/Excel/deck-text importers with preview-then-commit, exporters
   (Moxfield CSV, native CSV, Excel, Arena/MTGO text), PDF deck sheets.
6. **Polish & distribution** — deck covers using the `art` variant (**with the artist
   credit the policy requires**), a "clear image cache" control, licenses screen,
   settings (which slots into the ribbon beside Refresh, not into a view), overlay focus
   management, portable build + ZIP artifact, e2e smoke, and the second-sync file-growth
   decision (post-swap `VACUUM` — which REQUIRES `create_fts` after — versus shrinking
   `raw`). The `--chart-*` tokens are still stock greys and near-invisible on the dark
   background; the direction doc's **pie deeps** (`--color-pie-*`, shipped in Task 8) are
   what the value-stats charts should be built from.
