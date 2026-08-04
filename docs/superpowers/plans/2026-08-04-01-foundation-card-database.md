# Plan 1/6: Foundation & Card Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A launchable Tauri app that downloads Scryfall's `default_cards` bulk data (with 0-byte no-op update checks), ingests it into SQLite with FTS5, and searches it from a dark-themed React UI.

**Architecture:** Tauri 2.11 shell. Rust owns SQLite (rusqlite, bundled FTS5), the Scryfall HTTP client, and the streaming JSONL ingest (staging-table swap, progress events). React 19 + TS owns the UI; TanStack Query calls typed `invoke` wrappers. Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md`. Research facts: `docs/superpowers/research/2026-08-04-*.md`.

**Tech Stack:** Tauri 2.11, React 19, TypeScript 6.0.x, Vite, Tailwind CSS v4, shadcn/ui (`-b radix`), TanStack Query 5, @tanstack/react-virtual 3, zustand 5, rusqlite 0.40 (bundled), reqwest, flate2, serde_json, Vitest 4, httpmock.

## Global Constraints

- TypeScript **6.0.x** — NOT 7.x (no stable programmatic API; typescript-eslint incompatible).
- shadcn init MUST use `-b radix` (CLI default flipped to Base UI RC in July 2026).
- npm package `xlsx` is BANNED (frozen, unpatched CVEs) — not used in this plan, listed for completeness.
- Every request to `api.scryfall.com` sends `User-Agent: MTGCollectionTracker/0.1 (https://github.com/markusseerup/mtg-collection)` and `Accept: application/json;q=0.9,*/*;q=0.8`. 403 without them.
- Scryfall bulk files are **gzipped JSONL** (`jsonl_download_uri`); one JSON object per line, no outer array. The `.gz` is a real file, NOT `Content-Encoding` — do not enable reqwest's `gzip` feature.
- Rate limits: 10/s general API, 429 ⇒ back off 30 s. `*.scryfall.io` is unlimited.
- `cards` schema: `oracle_id`, `cmc`, `type_line` MUST be nullable (`reversible_card` layout lacks them); `collector_number` is TEXT; prices are decimal strings in JSON (derived REAL columns only for sort/filter); legalities stored as JSON, never fixed columns.
- All work on `main`, commit after every task, message style `feat:`/`fix:`/`chore:`/`test:`, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- App data lives in `<exe dir>/data/` with AppData fallback (dev mode: `src-tauri/data/` is fine via the same probe).

## File Structure

```
mtg-collection/
├── CLAUDE.md                          # agent instructions (Task 2)
├── package.json / vite.config.ts / tsconfig.json
├── src/                               # React renderer
│   ├── main.tsx, App.tsx              # shell + routing between views
│   ├── index.css                      # Tailwind v4 @theme tokens
│   ├── lib/ipc.ts                     # typed invoke wrappers + DTO types (mirror of Rust)
│   ├── lib/query.ts                   # QueryClient setup
│   ├── components/AppShell.tsx        # sidebar nav + header (Refresh button, sync status)
│   ├── components/SyncProgress.tsx    # first-run screen + toast progress
│   └── features/search/SearchPage.tsx # search box, filters, virtualized results
│   └── features/search/SearchPage.test.tsx
├── src-tauri/
│   ├── Cargo.toml, tauri.conf.json
│   └── src/
│       ├── main.rs / lib.rs           # builder, command registration, startup sync spawn
│       ├── paths.rs                   # resolve_data_dir (portable probe)
│       ├── db.rs                      # open_db, PRAGMAs, migrate(), FTS5
│       ├── card_row.rs                # CardRow::from_json (all layout gotchas)
│       ├── ingest.rs                  # gz → lines → staging → swap → FTS rebuild
│       ├── scryfall.rs                # HTTP client: check_bulk_update, download, fetch_sets
│       ├── sync.rs                    # orchestrator + sync_meta + progress events
│       └── search.rs                  # search_cards command
└── docs/…                             # spec, research, plans (existing)
```

Later plans build on: `db.rs` (user tables), `scryfall.rs` (images), `search.rs` (more filters), `ipc.ts` (more commands).

---

### Task 1: Scaffold Tauri + React + TS project

**Files:**
- Create: entire project skeleton via create-tauri-app (`package.json`, `vite.config.ts`, `src/`, `src-tauri/`), `.gitignore`

**Interfaces:**
- Produces: working `npm run tauri dev` / `npm run build`; `src-tauri` crate named `mtg-collection-tracker`; window title "MTG Collection Tracker".

- [ ] **Step 1: Verify prerequisites** (install only what's missing)

```powershell
node --version    # need >= 20
rustc --version   # if missing: winget install Rustlang.Rustup; rustup default stable-msvc
cargo --version
# MSVC linker check (required for Tauri on Windows):
rustup component list --installed   # toolchain must be *-msvc
```
If `link.exe` errors appear later: `winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended --quiet"`.

- [ ] **Step 2: Scaffold into the existing repo** (create-tauri-app needs an empty dir; scaffold to temp, move up)

```powershell
npm create tauri-app@latest tmp-scaffold -- --template react-ts --manager npm --yes
Get-ChildItem tmp-scaffold -Force | Move-Item -Destination . -Force
Remove-Item tmp-scaffold -Recurse -Force
npm install
```

- [ ] **Step 3: Configure identity & pin versions**

In `src-tauri/tauri.conf.json`: `productName: "MTG Collection Tracker"`, `identifier: "com.mtgcollection.tracker"`, window `title: "MTG Collection Tracker"`, `width: 1280, height: 800, minWidth: 1024, minHeight: 700`.
In `src-tauri/Cargo.toml`: package name `mtg-collection-tracker`, `tauri = "2"` (verify lockfile resolves ≥ 2.11).
In `package.json`: ensure `typescript` is `~6.0.3` (downgrade if template gave 7.x: `npm i -D typescript@~6.0.3`), `react`/`react-dom` `^19`.

- [ ] **Step 4: Replace `.gitignore`**

```gitignore
node_modules/
dist/
src-tauri/target/
src-tauri/data/
data/
*.local
.DS_Store
```

- [ ] **Step 5: Verify it builds**

```powershell
npm run build                                  # tsc + vite build
cargo check --manifest-path src-tauri/Cargo.toml
```
Expected: both succeed. (`npm run tauri dev` opens a window — verify manually if running interactively; CI-style check is build + cargo check.)

- [ ] **Step 6: Commit**

```powershell
git add -A; git commit -m "chore: scaffold Tauri 2 + React 19 + TypeScript app"
```

---

### Task 2: Tooling, Tailwind v4, shadcn, Vitest, CLAUDE.md

**Files:**
- Create: `eslint.config.js`, `.prettierrc`, `CLAUDE.md`, `src/lib/query.ts`, `src/index.css` (rewrite)
- Modify: `package.json` (scripts, devDeps), `vite.config.ts` (tailwind plugin + vitest config)

**Interfaces:**
- Produces: `npm run lint`, `npm run test:run`, `npm run verify` (build+lint+tests+cargo test); Tailwind v4 + shadcn initialized with Radix; `queryClient` export.

- [ ] **Step 1: Install and wire tooling**

```powershell
npm i -D eslint @eslint/js typescript-eslint prettier vitest @vitest/coverage-v8 jsdom @testing-library/react @testing-library/jest-dom @testing-library/user-event
npm i @tanstack/react-query zustand
npm i -D tailwindcss @tailwindcss/vite
npx shadcn@latest init -b radix   # accept defaults; verify components.json has "base": "radix"
```

`vite.config.ts`:
```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: { port: 1420, strictPort: true },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
```

`src/test-setup.ts`:
```ts
import "@testing-library/jest-dom/vitest";
```

`eslint.config.js`:
```js
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "src-tauri/", "node_modules/"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
```

`package.json` scripts:
```json
{
  "dev": "vite", "build": "tsc && vite build", "preview": "vite preview",
  "tauri": "tauri", "lint": "eslint .", "test": "vitest", "test:run": "vitest run",
  "verify": "npm run build && npm run lint && npm run test:run && cargo test --manifest-path src-tauri/Cargo.toml"
}
```

- [ ] **Step 2: Dark theme tokens** — `src/index.css`:

```css
@import "tailwindcss";

@theme {
  --color-bg: oklch(0.16 0.01 270);
  --color-surface: oklch(0.21 0.012 270);
  --color-border: oklch(0.3 0.01 270);
  --color-text: oklch(0.93 0.005 90);
  --color-muted: oklch(0.65 0.01 90);
  --color-accent: oklch(0.75 0.12 85);      /* gold */
  --color-accent-fg: oklch(0.2 0.02 85);
}
body { @apply bg-bg text-text antialiased; }
```

- [ ] **Step 3: QueryClient** — `src/lib/query.ts`:

```ts
import { QueryClient } from "@tanstack/react-query";
export const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
});
```

- [ ] **Step 4: Write `CLAUDE.md`** (repo root):

```markdown
# MTG Collection Tracker

Portable Windows desktop app for tracking a Magic: The Gathering collection.
Tauri 2.11 (Rust core) + React 19 + TypeScript 6. Single local user, SQLite storage,
Scryfall as the only external dependency.

## Commands
- `npm run tauri dev` — run the app (Vite HMR + Rust rebuild)
- `npm run verify` — build + lint + Vitest + cargo test. **Run before every commit.**
- `npm run test` / `test:run` — frontend tests; `cargo test` in `src-tauri/` — Rust tests

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
- Work on `main`, commit small after each task/step with `feat:`/`fix:`/`chore:`/`test:`.
- Tests: cover logic that can break (parsers, validation, sync). No ceremony tests.

## Working style (user preferences)
- Ultracode/dynamic workflows for large parallelizable work; subagents use Opus 5.
- Superpowers flow: brainstorm → spec → plan → subagent-driven implementation.
```

- [ ] **Step 5: Verify and commit**

```powershell
npm run build; npm run lint; npm run test:run   # test run passes with no test files (or trivial placeholder passes)
git add -A; git commit -m "chore: tooling (eslint, vitest, tailwind v4, shadcn/radix), CLAUDE.md"
```

---

### Task 3: Rust DB module + FTS5 spike (risk #1)

**Files:**
- Create: `src-tauri/src/db.rs`, `src-tauri/src/paths.rs`
- Modify: `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs` (mod decls)

**Interfaces:**
- Produces: `db::open(path: &Path) -> rusqlite::Result<Connection>` (WAL, synchronous=NORMAL, foreign_keys on); `paths::resolve_data_dir(exe_dir: &Path, appdata_dir: &Path) -> PathBuf` (writability probe).

- [ ] **Step 1: Add dependencies** to `src-tauri/Cargo.toml`:

```toml
[dependencies]
rusqlite = { version = "0.40", features = ["bundled"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
```

- [ ] **Step 2: Write the failing FTS5 spike test** (in `src-tauri/src/db.rs`):

```rust
use rusqlite::Connection;
use std::path::Path;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    Ok(conn)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fts5_with_diacritics_is_available() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE VIRTUAL TABLE t USING fts5(name, tokenize='unicode61 remove_diacritics 2');
             INSERT INTO t(name) VALUES ('Théoden of Rohan');",
        ).unwrap();
        let n: i64 = conn
            .query_row("SELECT count(*) FROM t WHERE t MATCH 'theoden'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn open_sets_wal() {
        let dir = std::env::temp_dir().join("mtgtest-db");
        std::fs::create_dir_all(&dir).unwrap();
        let conn = open(&dir.join("t.db")).unwrap();
        let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
    }
}
```

- [ ] **Step 3: Run** `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS if the bundled amalgamation includes FTS5. **If `no such module: fts5`:** set FTS5 compile flags — add to `src-tauri/.cargo/config.toml`:
```toml
[env]
LIBSQLITE3_FLAGS = "-DSQLITE_ENABLE_FTS5"
```
then `cargo clean -p libsqlite3-sys` and re-run. (Check libsqlite3-sys docs for a `bundled-full`/fts5 feature as an alternative.) This MUST pass before proceeding — it's spec risk #1.

- [ ] **Step 4: Portable data dir** — `src-tauri/src/paths.rs`:

```rust
use std::fs;
use std::path::{Path, PathBuf};

/// Prefer <exe dir>/data if creatable+writable, else <appdata>/data.
pub fn resolve_data_dir(exe_dir: &Path, appdata_dir: &Path) -> PathBuf {
    let portable = exe_dir.join("data");
    if dir_writable(&portable) {
        portable
    } else {
        let fallback = appdata_dir.join("data");
        let _ = fs::create_dir_all(&fallback);
        fallback
    }
}

fn dir_writable(dir: &Path) -> bool {
    if fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    let ok = fs::write(&probe, b"x").is_ok();
    let _ = fs::remove_file(&probe);
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_exe_dir_when_writable() {
        let tmp = std::env::temp_dir().join("mtgtest-paths");
        let exe = tmp.join("exe"); let app = tmp.join("app");
        std::fs::create_dir_all(&exe).unwrap();
        assert_eq!(resolve_data_dir(&exe, &app), exe.join("data"));
    }
}
```

- [ ] **Step 5: Register modules** in `src-tauri/src/lib.rs` (`mod db; mod paths;`), run `cargo test` again → all PASS.

- [ ] **Step 6: Commit** — `git add -A; git commit -m "feat: SQLite module with verified FTS5 + portable data dir resolution"`

---

### Task 4: Cards schema, migrations, staging swap

**Files:**
- Create: `src-tauri/src/schema.rs` (embedded SQL + migrate())
- Test: in-module `#[cfg(test)]`

**Interfaces:**
- Consumes: `db::open`.
- Produces: `schema::migrate(conn: &Connection) -> rusqlite::Result<()>` (idempotent, `PRAGMA user_version`); `schema::create_staging(conn) -> Result<()>` (fresh `cards_staging` clone); `schema::swap_staging(conn) -> Result<()>` (staging→cards, rebuilds `cards_fts`); tables `cards`, `sets`, `sync_meta(key TEXT PK, value TEXT)`.

- [ ] **Step 1: Write failing tests**

```rust
#[test]
fn migrate_is_idempotent_and_creates_tables() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    migrate(&conn).unwrap(); // no error on rerun
    let n: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE name IN ('cards','sets','sync_meta','cards_fts')",
        [], |r| r.get(0)).unwrap();
    assert_eq!(n, 4);
}

#[test]
fn staging_swap_replaces_cards_and_fts_finds_new_rows() {
    let conn = Connection::open_in_memory().unwrap();
    migrate(&conn).unwrap();
    conn.execute("INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw) VALUES ('old','Old Card','abc','1','en','normal','{}')", []).unwrap();
    create_staging(&conn).unwrap();
    conn.execute("INSERT INTO cards_staging (id, name, set_code, collector_number, lang, layout, raw) VALUES ('new','Lightning Bolt','lea','161','en','normal','{}')", []).unwrap();
    swap_staging(&conn).unwrap();
    let n: i64 = conn.query_row("SELECT count(*) FROM cards", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1);
    let hits: i64 = conn.query_row(
        "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'", [], |r| r.get(0)).unwrap();
    assert_eq!(hits, 1);
}
```

- [ ] **Step 2: Run to verify failure** (`migrate` undefined), then implement:

```rust
use rusqlite::Connection;

const CARDS_COLUMNS: &str = "
    id TEXT PRIMARY KEY,
    oracle_id TEXT,
    name TEXT NOT NULL,
    lang TEXT NOT NULL,
    released_at TEXT,
    set_code TEXT NOT NULL,
    set_name TEXT,
    collector_number TEXT NOT NULL,
    rarity TEXT,
    layout TEXT NOT NULL,
    mana_cost TEXT,
    cmc REAL,
    type_line TEXT,
    oracle_text TEXT,
    colors TEXT,
    color_identity TEXT,
    legalities TEXT,
    games TEXT,
    finishes TEXT,
    prices TEXT,
    price_usd REAL,
    price_eur REAL,
    faces TEXT,
    illustration_id TEXT,
    frame_effects TEXT,
    border_color TEXT,
    full_art INTEGER NOT NULL DEFAULT 0,
    promo INTEGER NOT NULL DEFAULT 0,
    promo_types TEXT,
    digital INTEGER NOT NULL DEFAULT 0,
    is_paper INTEGER NOT NULL DEFAULT 1,
    edhrec_rank INTEGER,
    game_changer INTEGER,
    image_status TEXT,
    image_updated_at TEXT,
    search_text TEXT,
    raw TEXT NOT NULL";

pub fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if v < 1 {
        conn.execute_batch(&format!(
            "BEGIN;
             CREATE TABLE IF NOT EXISTS cards ({CARDS_COLUMNS});
             CREATE INDEX IF NOT EXISTS idx_cards_oracle ON cards(oracle_id);
             CREATE INDEX IF NOT EXISTS idx_cards_set_cn ON cards(set_code, collector_number);
             CREATE INDEX IF NOT EXISTS idx_cards_name ON cards(name);
             CREATE TABLE IF NOT EXISTS sets (
                code TEXT PRIMARY KEY, name TEXT NOT NULL, arena_code TEXT, mtgo_code TEXT,
                set_type TEXT, released_at TEXT, icon_svg_uri TEXT);
             CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version = 1;
             COMMIT;"
        ))?;
        create_fts(conn)?;
    }
    Ok(())
}

fn create_fts(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS cards_fts;
         CREATE VIRTUAL TABLE cards_fts USING fts5(
            name, type_line, search_text,
            content='cards', tokenize='unicode61 remove_diacritics 2');
         INSERT INTO cards_fts(cards_fts) VALUES('rebuild');",
    )
}

pub fn create_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(&format!(
        "DROP TABLE IF EXISTS cards_staging;
         CREATE TABLE cards_staging ({CARDS_COLUMNS});",
    ))
}

pub fn swap_staging(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DROP TABLE IF EXISTS cards_fts;
         BEGIN;
         DROP TABLE cards;
         ALTER TABLE cards_staging RENAME TO cards;
         CREATE INDEX idx_cards_oracle ON cards(oracle_id);
         CREATE INDEX idx_cards_set_cn ON cards(set_code, collector_number);
         CREATE INDEX idx_cards_name ON cards(name);
         COMMIT;",
    )?;
    create_fts(conn)
}
```
Note: `search_text` is the FTS haystack (oracle text + all face names/text concatenated by ingest). FTS is dropped/recreated on swap — deterministic, avoids external-content rowid drift.

- [ ] **Step 3: Run tests** → PASS. **Step 4: Commit** `feat: cards/sets/sync_meta schema with staging swap + FTS5 rebuild`

---

### Task 5: CardRow parsing — every layout gotcha

**Files:**
- Create: `src-tauri/src/card_row.rs`, `src-tauri/tests/fixtures/cards_sample.jsonl` (10 hand-written lines covering: normal, transform (faces-only images), reversible_card (no top-level oracle_id/cmc/type_line), meld (no card_faces), split, etched-only finish, fractional cmc (Little Girl un-card style), `1★` collector number, digital-only Alchemy `A-` card, art_series with missing face images)

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
```rust
pub struct CardRow { /* one field per cards column except raw; pub */ }
impl CardRow {
    /// None => skip line (not a card object)
    pub fn from_json(v: &serde_json::Value) -> Option<CardRow>;
}
```
Field types: `id/name/lang/set_code/collector_number/layout: String`; `oracle_id/set_name/released_at/rarity/mana_cost/type_line/oracle_text/colors/color_identity/border_color/illustration_id/image_status/image_updated_at: Option<String>`; `cmc/price_usd/price_eur: Option<f64>`; `legalities/games/finishes/prices/faces/frame_effects/promo_types: Option<String>` (compact JSON re-serialization); `full_art/promo/digital/is_paper/game_changer: bool`; `edhrec_rank: Option<i64>`; `search_text: String`.

- [ ] **Step 1: Write failing tests** (in `card_row.rs`; fixtures shared with Task 6):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn parse(line: &str) -> CardRow {
        CardRow::from_json(&serde_json::from_str(line).unwrap()).unwrap()
    }

    #[test]
    fn normal_card_maps_hot_columns() {
        let c = parse(r#"{"object":"card","id":"aaa","oracle_id":"ooo","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","set_name":"Limited Edition Alpha","collector_number":"161","rarity":"common","cmc":1.0,"type_line":"Instant","oracle_text":"Deal 3 damage.","mana_cost":"{R}","colors":["R"],"color_identity":["R"],"legalities":{"vintage":"restricted"},"games":["paper"],"finishes":["nonfoil"],"prices":{"usd":"400.50","usd_foil":null,"usd_etched":null,"eur":"380.00","eur_foil":null,"tix":"1.2"},"digital":false}"#);
        assert_eq!(c.name, "Lightning Bolt");
        assert_eq!(c.colors.as_deref(), Some("R"));
        assert_eq!(c.price_usd, Some(400.50));
        assert!(c.is_paper);
        assert!(c.search_text.contains("Deal 3 damage."));
    }

    #[test]
    fn reversible_card_tolerates_missing_top_level_fields() {
        let c = parse(r#"{"object":"card","id":"bbb","name":"Jinnie Fay // Jinnie Fay","lang":"en","layout":"reversible_card","set":"sld","collector_number":"1556","games":["paper"],"finishes":["foil"],"digital":false,"card_faces":[{"name":"Jinnie Fay","oracle_id":"o1","cmc":3.0,"type_line":"Legendary Creature","oracle_text":"Face text.","image_uris":{"grid":"u"}},{"name":"Jinnie Fay","oracle_id":"o2","type_line":"Legendary Creature"}]}"#);
        assert_eq!(c.oracle_id.as_deref(), Some("o1")); // falls back to first face
        assert_eq!(c.cmc, Some(3.0));
        assert_eq!(c.type_line.as_deref(), Some("Legendary Creature"));
        assert!(c.search_text.contains("Face text."));
    }

    #[test]
    fn collector_number_star_and_fractional_cmc_survive() {
        let c = parse(r#"{"object":"card","id":"ccc","name":"Little Girl","lang":"en","layout":"normal","set":"unh","collector_number":"1★","cmc":0.5,"type_line":"Creature","games":["paper"],"finishes":["nonfoil"],"digital":false}"#);
        assert_eq!(c.collector_number, "1★");
        assert_eq!(c.cmc, Some(0.5));
    }

    #[test]
    fn non_card_object_returns_none() {
        assert!(CardRow::from_json(&serde_json::json!({"object":"error"})).is_none());
    }

    #[test]
    fn arena_only_card_is_not_paper() {
        let c = parse(r#"{"object":"card","id":"ddd","name":"A-Nadu","lang":"en","layout":"normal","set":"mh3","collector_number":"A-193","games":["arena"],"finishes":["nonfoil"],"digital":true}"#);
        assert!(!c.is_paper);
        assert!(c.digital);
    }
}
```

- [ ] **Step 2: Run → fail. Step 3: Implement:**

```rust
use serde_json::Value;

pub struct CardRow { /* fields as in Interfaces */ }

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}
fn joined_letters(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).collect::<String>())
}
fn compact(v: &Value, k: &str) -> Option<String> {
    v.get(k).filter(|x| !x.is_null()).map(|x| x.to_string())
}
fn price(v: &Value, k: &str) -> Option<f64> {
    v.get("prices")?.get(k)?.as_str()?.parse().ok()
}

impl CardRow {
    pub fn from_json(v: &Value) -> Option<CardRow> {
        if v.get("object")?.as_str()? != "card" { return None; }
        let faces = v.get("card_faces").and_then(Value::as_array);
        let face0 = faces.and_then(|f| f.first());
        let pick = |k: &str| s(v, k).or_else(|| face0.and_then(|f| s(f, k)));
        let cmc = v.get("cmc").and_then(Value::as_f64)
            .or_else(|| face0.and_then(|f| f.get("cmc")).and_then(Value::as_f64));
        let games: Vec<&str> = v.get("games").and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();

        let mut search_text = v.get("oracle_text").and_then(Value::as_str).unwrap_or("").to_string();
        if let Some(fs) = faces {
            for f in fs {
                for k in ["name", "type_line", "oracle_text"] {
                    if let Some(t) = f.get(k).and_then(Value::as_str) {
                        search_text.push(' '); search_text.push_str(t);
                    }
                }
            }
        }

        Some(CardRow {
            id: s(v, "id")?,
            name: s(v, "name")?,
            lang: s(v, "lang")?,
            set_code: s(v, "set")?,
            collector_number: s(v, "collector_number")?,
            layout: s(v, "layout")?,
            oracle_id: pick("oracle_id"),
            type_line: pick("type_line"),
            mana_cost: pick("mana_cost"),
            oracle_text: s(v, "oracle_text"),
            cmc,
            set_name: s(v, "set_name"),
            released_at: s(v, "released_at"),
            rarity: s(v, "rarity"),
            colors: joined_letters(v, "colors").or_else(|| face0.and_then(|f| joined_letters(f, "colors"))),
            color_identity: joined_letters(v, "color_identity"),
            legalities: compact(v, "legalities"),
            games: compact(v, "games"),
            finishes: compact(v, "finishes"),
            prices: compact(v, "prices"),
            price_usd: price(v, "usd").or_else(|| price(v, "usd_foil")).or_else(|| price(v, "usd_etched")),
            price_eur: price(v, "eur").or_else(|| price(v, "eur_foil")),
            faces: compact(v, "card_faces"),
            illustration_id: s(v, "illustration_id"),
            frame_effects: compact(v, "frame_effects"),
            border_color: s(v, "border_color"),
            full_art: v.get("full_art").and_then(Value::as_bool).unwrap_or(false),
            promo: v.get("promo").and_then(Value::as_bool).unwrap_or(false),
            promo_types: compact(v, "promo_types"),
            digital: v.get("digital").and_then(Value::as_bool).unwrap_or(false),
            is_paper: games.contains(&"paper"),
            edhrec_rank: v.get("edhrec_rank").and_then(Value::as_i64),
            game_changer: v.get("game_changer").and_then(Value::as_bool).unwrap_or(false),
            image_status: s(v, "image_status"),
            image_updated_at: s(v, "image_updated_at"),
            search_text,
        })
    }
}
```

- [ ] **Step 4: Run tests → PASS.** Also create `src-tauri/tests/fixtures/cards_sample.jsonl` with the 10 fixture lines (reuse the JSON from the tests plus meld/split/art_series/etched-only variants — one object per line, real Scryfall field shapes).
- [ ] **Step 5: Commit** `feat: CardRow JSONL parsing covering all Scryfall layout gotchas`

---

### Task 6: Streaming ingest pipeline

**Files:**
- Create: `src-tauri/src/ingest.rs`
- Modify: `src-tauri/Cargo.toml` (add `flate2 = "1"`)

**Interfaces:**
- Consumes: `schema::{migrate, create_staging, swap_staging}`, `CardRow::from_json`.
- Produces:
```rust
pub struct IngestStats { pub inserted: u64, pub skipped: u64 }
/// Streams a .jsonl.gz file into cards_staging, swaps atomically, rebuilds FTS.
/// progress(inserted) called every 1000 rows.
pub fn ingest_gz(conn: &mut Connection, gz_path: &Path,
                 progress: &mut dyn FnMut(u64)) -> Result<IngestStats, IngestError>;
```
`IngestError` (thiserror): `Io(std::io::Error)`, `Db(rusqlite::Error)`.

- [ ] **Step 1: Write failing test** (build a gz fixture in the test):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;

    fn gz_fixture(lines: &[&str]) -> std::path::PathBuf {
        let p = std::env::temp_dir().join(format!("mtgtest-{}.jsonl.gz", lines.len()));
        let mut enc = GzEncoder::new(std::fs::File::create(&p).unwrap(), Compression::fast());
        for l in lines { enc.write_all(l.as_bytes()).unwrap(); enc.write_all(b"\n").unwrap(); }
        enc.finish().unwrap();
        p
    }

    #[test]
    fn ingests_fixture_and_swaps() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw) VALUES ('stale','Stale','x','1','en','normal','{}')", []).unwrap();
        let sample = std::fs::read_to_string(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/cards_sample.jsonl")).unwrap();
        let lines: Vec<&str> = sample.lines().collect();
        let p = gz_fixture(&lines);
        let mut ticks = 0u32;
        let stats = ingest_gz(&mut conn, &p, &mut |_| ticks += 1).unwrap();
        assert_eq!(stats.inserted as usize, lines.len());
        let stale: i64 = conn.query_row("SELECT count(*) FROM cards WHERE id='stale'", [], |r| r.get(0)).unwrap();
        assert_eq!(stale, 0); // replaced by swap
        let bolt: i64 = conn.query_row(
            "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'", [], |r| r.get(0)).unwrap();
        assert!(bolt >= 1);
    }

    #[test]
    fn bad_lines_are_skipped_not_fatal() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let p = gz_fixture(&[r#"{"object":"card","id":"a","name":"Good","lang":"en","layout":"normal","set":"x","collector_number":"1","games":["paper"],"finishes":["nonfoil"],"digital":false}"#, "NOT JSON", r#"{"object":"token"}"#]);
        let stats = ingest_gz(&mut conn, &p, &mut |_| {}).unwrap();
        assert_eq!(stats.inserted, 1);
        assert_eq!(stats.skipped, 2);
    }
}
```

- [ ] **Step 2: Run → fail. Step 3: Implement:**

```rust
use crate::{card_row::CardRow, schema};
use flate2::read::GzDecoder;
use rusqlite::{params, Connection};
use std::io::{BufRead, BufReader};
use std::path::Path;

const BATCH: u64 = 2000;

pub fn ingest_gz(conn: &mut Connection, gz_path: &Path,
                 progress: &mut dyn FnMut(u64)) -> Result<IngestStats, IngestError> {
    schema::create_staging(conn)?;
    let reader = BufReader::new(GzDecoder::new(std::fs::File::open(gz_path)?));
    let mut stats = IngestStats { inserted: 0, skipped: 0 };
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO cards_staging (id, oracle_id, name, lang, released_at, set_code, set_name,
                collector_number, rarity, layout, mana_cost, cmc, type_line, oracle_text, colors,
                color_identity, legalities, games, finishes, prices, price_usd, price_eur, faces,
                illustration_id, frame_effects, border_color, full_art, promo, promo_types, digital,
                is_paper, edhrec_rank, game_changer, image_status, image_updated_at, search_text, raw)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
                ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37)")?;
        for line in reader.lines() {
            let line = line?;
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
                stats.skipped += 1; continue;
            };
            let Some(c) = CardRow::from_json(&v) else { stats.skipped += 1; continue; };
            stmt.execute(params![
                c.id, c.oracle_id, c.name, c.lang, c.released_at, c.set_code, c.set_name,
                c.collector_number, c.rarity, c.layout, c.mana_cost, c.cmc, c.type_line,
                c.oracle_text, c.colors, c.color_identity, c.legalities, c.games, c.finishes,
                c.prices, c.price_usd, c.price_eur, c.faces, c.illustration_id, c.frame_effects,
                c.border_color, c.full_art, c.promo, c.promo_types, c.digital, c.is_paper,
                c.edhrec_rank, c.game_changer, c.image_status, c.image_updated_at, c.search_text,
                line,
            ])?;
            stats.inserted += 1;
            if stats.inserted % BATCH == 0 { progress(stats.inserted); }
        }
    }
    tx.commit()?;
    schema::swap_staging(conn)?;
    progress(stats.inserted);
    Ok(stats)
}
```
(Single transaction for the whole staging load is correct here — staging is invisible until swap; a crash rolls back cleanly.)

- [ ] **Step 4: Run tests → PASS. Step 5: Commit** `feat: streaming gz JSONL ingest with staging swap`

---

### Task 7: Scryfall HTTP client

**Files:**
- Create: `src-tauri/src/scryfall.rs`
- Modify: `src-tauri/Cargo.toml`:

```toml
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls", "stream"] }
tokio = { version = "1", features = ["fs", "io-util"] }
futures-util = "0.3"
[dev-dependencies]
httpmock = "0.8"
```

**Interfaces:**
- Produces:
```rust
pub const USER_AGENT: &str = "MTGCollectionTracker/0.1 (https://github.com/markusseerup/mtg-collection)";
pub struct Client { /* reqwest::Client + base_url override for tests */ }
pub enum BulkCheck { NotModified, Available(BulkInfo) }
pub struct BulkInfo { pub jsonl_download_uri: String, pub updated_at: String,
                      pub compressed_size: u64, pub etag: Option<String> }
impl Client {
    pub fn new(base_url: String) -> Client;              // prod: "https://api.scryfall.com"
    pub async fn check_bulk_update(&self, etag: Option<&str>) -> Result<BulkCheck, ScryfallError>;
    /// Downloads to dest (resumes via Range if dest exists), verifies expected_size.
    pub async fn download(&self, uri: &str, dest: &Path, expected_size: u64,
                          progress: &mut dyn FnMut(u64, u64)) -> Result<(), ScryfallError>;
    /// Paginated GET /sets -> Vec<SetRow>
    pub async fn fetch_sets(&self) -> Result<Vec<SetRow>, ScryfallError>;
}
pub struct SetRow { pub code: String, pub name: String, pub arena_code: Option<String>,
                    pub mtgo_code: Option<String>, pub set_type: Option<String>,
                    pub released_at: Option<String>, pub icon_svg_uri: Option<String> }
```
`ScryfallError` (thiserror): `Http(reqwest::Error)`, `Io(std::io::Error)`, `SizeMismatch { expected: u64, actual: u64 }`, `RateLimited`, `Unexpected(String)`.

- [ ] **Step 1: Write failing httpmock tests:**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use httpmock::prelude::*;

    #[tokio::test]
    async fn etag_match_returns_not_modified() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards")
                .header("if-none-match", "W/\"abc\"");
            then.status(304);
        });
        let c = Client::new(server.base_url());
        matches!(c.check_bulk_update(Some("W/\"abc\"")).await.unwrap(),
                 BulkCheck::NotModified);
    }

    #[tokio::test]
    async fn fresh_check_parses_bulk_info() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/bulk-data/default_cards")
                .header_exists("user-agent");
            then.status(200).header("etag", "W/\"xyz\"")
                .json_body(serde_json::json!({
                    "object":"bulk_data","type":"default_cards",
                    "updated_at":"2026-08-03T21:16:27.869+00:00",
                    "jsonl_download_uri":"https://data.scryfall.io/default-cards/x.jsonl.gz",
                    "compressed_size":77332681u64 }));
        });
        let c = Client::new(server.base_url());
        let BulkCheck::Available(info) = c.check_bulk_update(None).await.unwrap() else { panic!() };
        assert_eq!(info.compressed_size, 77332681);
        assert_eq!(info.etag.as_deref(), Some("W/\"xyz\""));
    }

    #[tokio::test]
    async fn download_verifies_size_and_reports_progress() {
        let server = MockServer::start();
        let body = vec![7u8; 1000];
        server.mock(|when, then| {
            when.method(GET).path("/file.gz");
            then.status(200).body(body.clone());
        });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl.gz");
        let _ = std::fs::remove_file(&dest);
        let mut seen = 0u64;
        c.download(&format!("{}/file.gz", server.base_url()), &dest, 1000,
                   &mut |done, _| seen = done).await.unwrap();
        assert_eq!(seen, 1000);
        assert_eq!(std::fs::metadata(&dest).unwrap().len(), 1000);
    }

    #[tokio::test]
    async fn download_size_mismatch_errors() {
        let server = MockServer::start();
        server.mock(|when, then| { when.method(GET).path("/f.gz"); then.status(200).body("short"); });
        let c = Client::new(server.base_url());
        let dest = std::env::temp_dir().join("mtgtest-dl2.gz");
        let _ = std::fs::remove_file(&dest);
        let err = c.download(&format!("{}/f.gz", server.base_url()), &dest, 9999, &mut |_,_| {}).await;
        assert!(matches!(err, Err(ScryfallError::SizeMismatch { .. })));
    }

    #[tokio::test]
    async fn fetch_sets_follows_pagination() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/sets").query_param("page", "2");
            then.status(200).json_body(serde_json::json!({
                "has_more": false, "data": [{"code":"dom","name":"Dominaria","arena_code":"dar"}]}));
        });
        server.mock(|when, then| {
            when.method(GET).path("/sets");
            then.status(200).json_body(serde_json::json!({
                "has_more": true,
                "next_page": format!("{}/sets?page=2", server.base_url()),
                "data": [{"code":"lea","name":"Limited Edition Alpha"}]}));
        });
        let c = Client::new(server.base_url());
        let sets = c.fetch_sets().await.unwrap();
        assert_eq!(sets.len(), 2);
        assert_eq!(sets[1].arena_code.as_deref(), Some("dar"));
    }
}
```

- [ ] **Step 2: Run → fail. Step 3: Implement** (key parts):

```rust
impl Client {
    pub fn new(base_url: String) -> Client {
        let http = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .build().expect("client");
        Client { http, base_url }
    }

    pub async fn check_bulk_update(&self, etag: Option<&str>) -> Result<BulkCheck, ScryfallError> {
        let mut req = self.http.get(format!("{}/bulk-data/default_cards", self.base_url))
            .header("Accept", "application/json;q=0.9,*/*;q=0.8");
        if let Some(e) = etag { req = req.header("If-None-Match", e); }
        let resp = req.send().await?;
        match resp.status().as_u16() {
            304 => Ok(BulkCheck::NotModified),
            429 => Err(ScryfallError::RateLimited),
            200 => {
                let etag = resp.headers().get("etag")
                    .and_then(|v| v.to_str().ok()).map(str::to_owned);
                let v: serde_json::Value = resp.json().await?;
                Ok(BulkCheck::Available(BulkInfo {
                    jsonl_download_uri: v["jsonl_download_uri"].as_str()
                        .ok_or_else(|| ScryfallError::Unexpected("no jsonl_download_uri".into()))?.to_owned(),
                    updated_at: v["updated_at"].as_str().unwrap_or_default().to_owned(),
                    compressed_size: v["compressed_size"].as_u64().unwrap_or(0),
                    etag,
                }))
            }
            s => Err(ScryfallError::Unexpected(format!("status {s}"))),
        }
    }

    pub async fn download(&self, uri: &str, dest: &Path, expected_size: u64,
                          progress: &mut dyn FnMut(u64, u64)) -> Result<(), ScryfallError> {
        use futures_util::StreamExt;
        use std::io::Write;
        let existing = std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0);
        let mut req = self.http.get(uri);
        if existing > 0 && existing < expected_size {
            req = req.header("Range", format!("bytes={existing}-"));
        }
        let resp = req.send().await?;
        let (mut file, mut done) = if resp.status().as_u16() == 206 {
            (std::fs::OpenOptions::new().append(true).open(dest)?, existing)
        } else {
            (std::fs::File::create(dest)?, 0)
        };
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk)?;
            done += chunk.len() as u64;
            progress(done, expected_size);
        }
        file.flush()?;
        let actual = std::fs::metadata(dest)?.len();
        if actual != expected_size {
            return Err(ScryfallError::SizeMismatch { expected: expected_size, actual });
        }
        Ok(())
    }

    pub async fn fetch_sets(&self) -> Result<Vec<SetRow>, ScryfallError> {
        let mut url = format!("{}/sets", self.base_url);
        let mut out = Vec::new();
        loop {
            let v: serde_json::Value = self.http.get(&url)
                .header("Accept", "application/json;q=0.9,*/*;q=0.8")
                .send().await?.json().await?;
            for s in v["data"].as_array().into_iter().flatten() {
                out.push(SetRow {
                    code: s["code"].as_str().unwrap_or_default().to_owned(),
                    name: s["name"].as_str().unwrap_or_default().to_owned(),
                    arena_code: s["arena_code"].as_str().map(str::to_owned),
                    mtgo_code: s["mtgo_code"].as_str().map(str::to_owned),
                    set_type: s["set_type"].as_str().map(str::to_owned),
                    released_at: s["released_at"].as_str().map(str::to_owned),
                    icon_svg_uri: s["icon_svg_uri"].as_str().map(str::to_owned),
                });
            }
            if v["has_more"].as_bool() == Some(true) {
                url = v["next_page"].as_str().unwrap_or_default().to_owned();
                if url.is_empty() { break; }
            } else { break; }
        }
        Ok(out)
    }
}
```

- [ ] **Step 4: Run tests → PASS. Step 5: Commit** `feat: Scryfall client with ETag checks, resumable downloads, sets pagination`

---

### Task 8: Sync orchestrator + Tauri commands + startup hook

**Files:**
- Create: `src-tauri/src/sync.rs`
- Modify: `src-tauri/src/lib.rs` (AppState, command registration, startup spawn)

**Interfaces:**
- Consumes: `scryfall::Client`, `ingest::ingest_gz`, `db`, `schema`, `paths`.
- Produces:
  - Rust: `sync::run_sync(state, app_handle, force: bool) -> Result<SyncOutcome, String>`; meta helpers `get_meta(conn, key) -> Option<String>` / `set_meta(conn, key, value)`; keys: `bulk_etag`, `bulk_updated_at`, `last_check_at`, `last_ingest_at`, `card_count`.
  - Tauri commands: `sync_run(force: bool) -> SyncOutcome`, `sync_status() -> SyncStatus`.
  - Events (all `serde` camelCase): `sync:progress` payload `{ phase: "checking"|"downloading"|"ingesting"|"sets"|"done"|"error", done: u64, total: u64, message: Option<String> }`.
  - DTOs: `SyncOutcome { updated: bool, card_count: i64, updated_at: Option<String> }`, `SyncStatus { card_count: i64, last_check_at: Option<String>, bulk_updated_at: Option<String>, data_dir: String, syncing: bool }`.
  - `AppState { db: Mutex<Connection>, data_dir: PathBuf, syncing: AtomicBool, client: scryfall::Client }` managed by Tauri.
- 24 h throttle: skip check when `force == false` and `last_check_at` is < 24 h old (RFC3339 compare using `std::time::SystemTime` serialized as unix seconds — store `last_check_at` as unix seconds string).

- [ ] **Step 1: Write failing tests** for the pure parts (throttle + meta):

```rust
#[test]
fn meta_roundtrip() {
    let conn = Connection::open_in_memory().unwrap();
    crate::schema::migrate(&conn).unwrap();
    assert!(get_meta(&conn, "bulk_etag").is_none());
    set_meta(&conn, "bulk_etag", "W/\"abc\"").unwrap();
    assert_eq!(get_meta(&conn, "bulk_etag").as_deref(), Some("W/\"abc\""));
}

#[test]
fn throttle_skips_recent_check() {
    let now = 1_800_000_000u64;
    assert!(should_check(None, now, false));                       // never checked
    assert!(!should_check(Some(now - 3600), now, false));           // 1h ago, no force
    assert!(should_check(Some(now - 3600), now, true));             // forced
    assert!(should_check(Some(now - 90_000), now, false));          // >24h
}
```

- [ ] **Step 2: Implement** `should_check(last: Option<u64>, now: u64, force: bool) -> bool` (`force || last.map_or(true, |l| now - l >= 86_400)`), meta helpers (`INSERT ... ON CONFLICT(key) DO UPDATE`), and the orchestrator:

```rust
pub async fn run_sync(state: Arc<AppState>, app: tauri::AppHandle, force: bool)
    -> Result<SyncOutcome, String> {
    use tauri::Emitter;
    if state.syncing.swap(true, Ordering::SeqCst) {
        return Err("sync already running".into());
    }
    let result = do_sync(&state, &app, force).await;
    state.syncing.store(false, Ordering::SeqCst);
    if let Err(e) = &result {
        let _ = app.emit("sync:progress", Progress::error(e.clone()));
    }
    result
}

async fn do_sync(state: &AppState, app: &tauri::AppHandle, force: bool)
    -> Result<SyncOutcome, String> {
    let now = unix_now();
    let (etag, last_check, card_count) = { /* lock db, read meta + SELECT count(*) FROM cards */ };
    if !should_check(last_check, now, force) {
        return Ok(SyncOutcome { updated: false, card_count, updated_at: None });
    }
    emit(app, "checking", 0, 0);
    let check = state.client.check_bulk_update(etag.as_deref()).await.map_err(|e| e.to_string())?;
    { /* set_meta last_check_at = now */ }
    let BulkCheck::Available(info) = check else {
        return Ok(SyncOutcome { updated: false, card_count, updated_at: None });
    };
    // Guard: 200 with same updated_at as stored (ETag lost) => still up to date
    let gz = state.data_dir.join("tmp").join("default-cards.jsonl.gz");
    std::fs::create_dir_all(gz.parent().unwrap()).map_err(|e| e.to_string())?;
    let mut last_emit = 0u64;
    state.client.download(&info.jsonl_download_uri, &gz, info.compressed_size,
        &mut |done, total| { if done - last_emit > 1_000_000 { emit(app, "downloading", done, total); last_emit = done; } })
        .await.map_err(|e| e.to_string())?;
    let stats = {
        let mut conn = state.db.lock().unwrap();
        // ~116k rows expected; emit per 1000 handled by ingest callback
        ingest::ingest_gz(&mut conn, &gz, &mut |n| emit(app, "ingesting", n, 117_000))
            .map_err(|e| e.to_string())?
    };
    emit(app, "sets", 0, 0);
    let sets = state.client.fetch_sets().await.map_err(|e| e.to_string())?;
    { /* lock db; INSERT OR REPLACE each SetRow; set_meta bulk_etag/bulk_updated_at/last_ingest_at/card_count */ }
    let _ = std::fs::remove_file(&gz);
    emit(app, "done", stats.inserted, stats.inserted);
    Ok(SyncOutcome { updated: true, card_count: stats.inserted as i64,
                     updated_at: Some(info.updated_at) })
}
```
Commands in `lib.rs`:
```rust
#[tauri::command]
async fn sync_run(state: tauri::State<'_, Arc<AppState>>, app: tauri::AppHandle, force: bool)
    -> Result<sync::SyncOutcome, String> {
    sync::run_sync(state.inner().clone(), app, force).await
}
#[tauri::command]
fn sync_status(state: tauri::State<'_, Arc<AppState>>) -> sync::SyncStatus { /* read meta + counts */ }
```
Setup in `lib.rs::run()`: resolve data dir (`std::env::current_exe()` parent + `app.path().app_data_dir()`), `db::open(data_dir.join("mtg.db"))`, `schema::migrate`, manage `Arc<AppState>`, and `tauri::async_runtime::spawn(run_sync(state, handle, false))` after setup. Register `generate_handler![sync_run, sync_status, search_cards]` (search_cards arrives in Task 9 — add it then).

- [ ] **Step 3: Run `cargo test` → PASS (pure parts) and `cargo check` → clean. Step 4: Commit** `feat: sync orchestrator with 24h throttle, progress events, startup hook`

---

### Task 9: search_cards command

**Files:**
- Create: `src-tauri/src/search.rs`

**Interfaces:**
- Consumes: `cards` + `cards_fts` tables.
- Produces (serde camelCase both ways):
```rust
#[derive(serde::Deserialize)] #[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub text: Option<String>,          // FTS prefix match on name/type/search_text
    pub format: Option<String>,        // legalities key; matches legal|restricted
    pub colors: Option<String>,        // subset match on color_identity, e.g. "WU"; "C" = colorless
    pub set_code: Option<String>,
    pub rarity: Option<String>,
    pub paper_only: Option<bool>,      // default true
    pub sort: Option<String>,          // "name" (default) | "released" | "price"
    pub limit: u32,                    // clamp 1..=200
    pub offset: u32,
}
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct CardSummary {
    pub id: String, pub name: String, pub set_code: String, pub set_name: Option<String>,
    pub collector_number: String, pub rarity: Option<String>, pub type_line: Option<String>,
    pub mana_cost: Option<String>, pub price_usd: Option<f64>, pub layout: String,
}
#[derive(serde::Serialize)] #[serde(rename_all = "camelCase")]
pub struct SearchResponse { pub items: Vec<CardSummary>, pub total: i64 }
#[tauri::command] pub fn search_cards(state: State<Arc<AppState>>, req: SearchRequest)
    -> Result<SearchResponse, String>;
```

- [ ] **Step 1: Write failing tests** against a seeded in-memory DB (pure fn `run_search(conn, &req)` that the command wraps):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let rows = [
            ("1","Lightning Bolt","lea","161","Instant","R","R","common", 400.5, r#"{"vintage":"restricted","modern":"legal","standard":"not_legal"}"#, 1),
            ("2","Lightning Helix","rav","213","Instant","RW","RW","uncommon", 1.5, r#"{"modern":"legal"}"#, 1),
            ("3","Черная Молния","alc","1","Sorcery","B","B","rare", 0.5, r#"{"alchemy":"legal"}"#, 0),
        ];
        for (id,name,set,cn,tl,c,ci,r,usd,leg,paper) in rows {
            conn.execute("INSERT INTO cards (id,name,set_code,collector_number,lang,layout,type_line,colors,color_identity,rarity,price_usd,legalities,is_paper,search_text,raw)
                VALUES (?1,?2,?3,?4,'en','normal',?5,?6,?7,?8,?9,?10,?11,?2,'{}')",
                rusqlite::params![id,name,set,cn,tl,c,ci,r,usd,leg,paper]).unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');").unwrap();
        conn
    }

    #[test]
    fn text_prefix_search_matches() {
        let conn = seeded();
        let r = run_search(&conn, &SearchRequest { text: Some("light bol".into()),
            limit: 50, ..Default::default() }).unwrap();
        assert_eq!(r.total, 1);
        assert_eq!(r.items[0].name, "Lightning Bolt");
    }

    #[test]
    fn format_filter_includes_restricted() {
        let conn = seeded();
        let r = run_search(&conn, &SearchRequest { format: Some("vintage".into()),
            limit: 50, ..Default::default() }).unwrap();
        assert_eq!(r.total, 1);
    }

    #[test]
    fn color_subset_filter() {
        let conn = seeded();
        let r = run_search(&conn, &SearchRequest { colors: Some("RW".into()),
            limit: 50, ..Default::default() }).unwrap();
        assert_eq!(r.total, 2); // R and RW both ⊆ RW
    }

    #[test]
    fn paper_only_default_excludes_digital() {
        let conn = seeded();
        let r = run_search(&conn, &SearchRequest { limit: 50, ..Default::default() }).unwrap();
        assert_eq!(r.total, 2);
    }

    #[test]
    fn fts_special_chars_do_not_panic() {
        let conn = seeded();
        for evil in ["\"", "OR", "name:", "( ", "*"] {
            run_search(&conn, &SearchRequest { text: Some(evil.into()),
                limit: 10, ..Default::default() }).unwrap();
        }
    }
}
```
(`SearchRequest` derives `Default` for tests: `limit: 0` clamps to 50.)

- [ ] **Step 2: Run → fail. Step 3: Implement** `run_search`:

```rust
pub fn run_search(conn: &Connection, req: &SearchRequest) -> Result<SearchResponse, String> {
    let limit = if req.limit == 0 { 50 } else { req.limit.min(200) };
    let mut wheres: Vec<String> = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    if let Some(text) = req.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        // sanitize: alphanumeric tokens only, each quoted with prefix *
        let toks: Vec<String> = text.split_whitespace()
            .map(|t| t.chars().filter(|c| c.is_alphanumeric()).collect::<String>())
            .filter(|t| !t.is_empty())
            .map(|t| format!("\"{t}\"*")).collect();
        if !toks.is_empty() {
            wheres.push("c.rowid IN (SELECT rowid FROM cards_fts WHERE cards_fts MATCH ?)".into());
            params.push(Box::new(toks.join(" ")));
        }
    }
    if let Some(f) = &req.format {
        wheres.push("json_extract(c.legalities, '$.' || ?) IN ('legal','restricted')".into());
        params.push(Box::new(f.clone()));
    }
    if let Some(colors) = &req.colors {
        if colors == "C" {
            wheres.push("(c.color_identity = '' OR c.color_identity IS NULL)".into());
        } else {
            // subset: every char of card identity must be in the filter
            for ch in ["W","U","B","R","G"] {
                if !colors.contains(ch) {
                    wheres.push(format!("instr(coalesce(c.color_identity,''), '{ch}') = 0"));
                }
            }
        }
    }
    if let Some(s) = &req.set_code { wheres.push("c.set_code = ?".into()); params.push(Box::new(s.clone())); }
    if let Some(r) = &req.rarity { wheres.push("c.rarity = ?".into()); params.push(Box::new(r.clone())); }
    if req.paper_only.unwrap_or(true) { wheres.push("c.is_paper = 1".into()); }

    let where_sql = if wheres.is_empty() { "1=1".to_string() } else { wheres.join(" AND ") };
    let order = match req.sort.as_deref() {
        Some("released") => "c.released_at DESC",
        Some("price") => "c.price_usd DESC NULLS LAST",
        _ => "c.name ASC, c.released_at DESC",
    };
    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout,
                count(*) OVER () AS total
         FROM cards c WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    params.push(Box::new(limit)); params.push(Box::new(req.offset));
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let mut rows = stmt.query(rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())))
        .map_err(|e| e.to_string())?;
    let mut items = Vec::new(); let mut total = 0i64;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        total = row.get(10).map_err(|e| e.to_string())?;
        items.push(CardSummary {
            id: row.get(0).unwrap(), name: row.get(1).unwrap(), set_code: row.get(2).unwrap(),
            set_name: row.get(3).unwrap(), collector_number: row.get(4).unwrap(),
            rarity: row.get(5).unwrap(), type_line: row.get(6).unwrap(),
            mana_cost: row.get(7).unwrap(), price_usd: row.get(8).unwrap(),
            layout: row.get(9).unwrap(),
        });
    }
    Ok(SearchResponse { items, total })
}
```
Register `search_cards` in `generate_handler!`. (Window-function `count(*) OVER ()` avoids a second query; `NULLS LAST` is supported in SQLite ≥3.30.)

- [ ] **Step 4: Run tests → PASS. Step 5: Commit** `feat: card search command (FTS prefix, format/color/set filters)`

---

### Task 10: Typed IPC layer + app shell + sync UI

**Files:**
- Create: `src/lib/ipc.ts`, `src/components/AppShell.tsx`, `src/components/SyncProgress.tsx`
- Modify: `src/App.tsx`, `src/main.tsx`
- Test: `src/lib/ipc.test.ts` (type-level smoke), `src/components/AppShell.test.tsx`

**Interfaces:**
- Consumes: Rust DTOs from Tasks 8–9 (names/casing MUST match `rename_all = "camelCase"`).
- Produces `src/lib/ipc.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface SearchRequest {
  text?: string; format?: string; colors?: string; setCode?: string; rarity?: string;
  paperOnly?: boolean; sort?: "name" | "released" | "price"; limit: number; offset: number;
}
export interface CardSummary {
  id: string; name: string; setCode: string; setName: string | null;
  collectorNumber: string; rarity: string | null; typeLine: string | null;
  manaCost: string | null; priceUsd: number | null; layout: string;
}
export interface SearchResponse { items: CardSummary[]; total: number }
export interface SyncOutcome { updated: boolean; cardCount: number; updatedAt: string | null }
export interface SyncStatus {
  cardCount: number; lastCheckAt: string | null; bulkUpdatedAt: string | null;
  dataDir: string; syncing: boolean;
}
export interface SyncProgressEvent {
  phase: "checking" | "downloading" | "ingesting" | "sets" | "done" | "error";
  done: number; total: number; message: string | null;
}

export const ipc = {
  searchCards: (req: SearchRequest) => invoke<SearchResponse>("search_cards", { req }),
  syncRun: (force: boolean) => invoke<SyncOutcome>("sync_run", { force }),
  syncStatus: () => invoke<SyncStatus>("sync_status"),
  onSyncProgress: (cb: (e: SyncProgressEvent) => void): Promise<UnlistenFn> =>
    listen<SyncProgressEvent>("sync:progress", (evt) => cb(evt.payload)),
};
```

- [ ] **Step 1: Write failing AppShell test:**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
vi.mock("../lib/ipc", () => ({
  ipc: {
    syncStatus: vi.fn().mockResolvedValue({ cardCount: 5, lastCheckAt: null,
      bulkUpdatedAt: null, dataDir: "d", syncing: false }),
    syncRun: vi.fn(), onSyncProgress: vi.fn().mockResolvedValue(() => {}),
  },
}));
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders nav and refresh button", async () => {
    render(<AppShell><div>content</div></AppShell>);
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Collection")).toBeInTheDocument();
    expect(screen.getByText("Decks")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /refresh/i })).toBeInTheDocument();
    expect(screen.getByText("content")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run → fail. Step 3: Implement** `AppShell` (left sidebar: Search / Collection / Wishlist / Decks / Settings as nav items — non-Search items render "coming in a later plan" placeholders; header: app title, Refresh button calling `ipc.syncRun(true)` disabled while syncing, subtle status line "116,568 cards · data from 2026-08-03" from `syncStatus`), `SyncProgress` (subscribes `onSyncProgress`; renders a slim progress bar + phase label; full-screen variant when `cardCount === 0` — first run), wire in `App.tsx` with `QueryClientProvider` + a `zustand` store for `activeView`.

- [ ] **Step 4: Run `npm run test:run` → PASS; `npm run build` clean. Step 5: Commit** `feat: typed IPC layer, app shell with nav + refresh, sync progress UI`

---

### Task 11: Search page (debounced FTS + virtualized results)

**Files:**
- Create: `src/features/search/SearchPage.tsx`, `src/features/search/SearchPage.test.tsx`
- Modify: `src/App.tsx` (route Search view)
- Deps: `npm i @tanstack/react-virtual`

**Interfaces:**
- Consumes: `ipc.searchCards`, `CardSummary`.
- Produces: `<SearchPage />` — search input (300 ms debounce), format `<select>` (Standard/Pioneer/Modern/Legacy/Vintage/Pauper/Commander — values are Scryfall keys), five color toggle buttons + C, virtualized result table rows (name, set+CN, type, rarity, USD price right-aligned) via `useInfiniteQuery` (pageParam = offset, 50/page) + `useVirtualizer`.

- [ ] **Step 1: Write failing tests:**

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const searchCards = vi.fn().mockResolvedValue({
  items: [{ id: "1", name: "Lightning Bolt", setCode: "lea", setName: "Alpha",
    collectorNumber: "161", rarity: "common", typeLine: "Instant",
    manaCost: "{R}", priceUsd: 400.5, layout: "normal" }],
  total: 1,
});
vi.mock("../../lib/ipc", () => ({ ipc: { searchCards: (r: unknown) => searchCards(r) } }));
import { SearchPage } from "./SearchPage";

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("SearchPage", () => {
  it("searches after debounce and renders results", async () => {
    wrap(<SearchPage />);
    await userEvent.type(screen.getByPlaceholderText(/search cards/i), "bolt");
    await waitFor(() => expect(screen.getByText("Lightning Bolt")).toBeInTheDocument());
    expect(searchCards).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "bolt", offset: 0 }));
    expect(screen.getByText(/\$400\.50/)).toBeInTheDocument();
  });

  it("passes format filter", async () => {
    wrap(<SearchPage />);
    await userEvent.selectOptions(screen.getByLabelText(/format/i), "modern");
    await waitFor(() => expect(searchCards).toHaveBeenLastCalledWith(
      expect.objectContaining({ format: "modern" })));
  });
});
```
(jsdom has no layout — mock `Element.prototype.getBoundingClientRect` in test-setup if the virtualizer renders zero rows; assert on data presence, not row virtualization mechanics.)

- [ ] **Step 2: Run → fail. Step 3: Implement** SearchPage: `useState` for text/format/colors, `useDeferredValue`-style debounce via `useEffect` + `setTimeout(300)` into `debouncedText`, `useInfiniteQuery({ queryKey: ["search", debouncedText, format, colors], queryFn: ({ pageParam }) => ipc.searchCards({ text: debouncedText || undefined, format, colors, limit: 50, offset: pageParam }), initialPageParam: 0, getNextPageParam: (last, all) => { const seen = all.reduce((n, p) => n + p.items.length, 0); return seen < last.total ? seen : undefined; } })`, flatten pages, `useVirtualizer({ count: rows.length, estimateSize: () => 44 })` over a `ref` scroll container, `onScroll` fetches next page at 80%. Show `total` count above results; empty state when DB is empty points at sync status.

- [ ] **Step 4: Run `npm run test:run` → PASS. Step 5: Commit** `feat: search page with debounced FTS search and virtualized results`

---

### Task 12: Full verify + manual smoke + plan wrap

**Files:**
- Modify: `CLAUDE.md` (any command corrections discovered), plan checkboxes

- [ ] **Step 1:** `npm run verify` — all four stages green. Fix anything that isn't.
- [ ] **Step 2: Manual smoke** (requires interactive run): `npm run tauri dev` — expect: window opens; first-run screen appears; real download (~77 MB) + ingest completes in under ~2 min; search "lightning bolt" returns results with prices; Refresh button reports up-to-date. Record actual ingest duration in the commit message (spec risk #6 benchmark).
- [ ] **Step 3:** Check off all boxes in this plan file, commit `chore: complete plan 1 (foundation & card database)`.

---

## Later plans (not in this document)

2. **Images & card browsing** — image cache + custom protocol, card grid with art, card detail (faces, printings, legality chips), pre-warm job.
3. **Collection & wishlist** — user tables, entry editor (finish/condition/qty), collection views, value stats, migrations reconciler.
4. **Deckbuilder & validation** — deck CRUD, zones, drag-and-drop, format_specs seeding, full TS validation engine (restricted semantics, singleton exceptions, commanders/partners/companions, color identity).
5. **Import/export** — CSV/Excel/deck-text importers with preview, exporters (Moxfield CSV, native CSV, Excel, Arena/MTGO text), PDF deck sheets.
6. **Polish & distribution** — deck covers/custom art, licenses screen, settings, portable build + ZIP artifact, e2e smoke.
