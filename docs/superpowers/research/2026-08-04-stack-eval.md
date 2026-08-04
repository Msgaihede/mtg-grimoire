# Research: stack-eval (2026-08-04)

## Summary

Two 2026-specific facts reshape this decision and both favor Electron. (1) better-sqlite3 13.0.2 (2026-07-29) moved to N-API and now ships `prebuilds/win32-x64.node` (1,989,632 bytes) directly inside the npm tarball — node-gyp, @electron/rebuild and VS Build Tools are no longer needed at all, killing the single biggest historical Electron+SQLite objection. (2) The "~500MB JSON file" premise is obsolete: Scryfall retired monolithic JSON arrays on 2026-07-20 and now serves **gzipped JSONL only** (`default_cards` = 77.3 MB gz / ~500 MB raw / 105,651 prints, verified live 2026-08-03), so ingestion is a streaming line-by-line job in every candidate stack and Rust/.NET's parsing advantage is worth seconds on a once-a-week background task — not a differentiator. What remains differentiating is exactly where the web stack is 5-10x deeper: image-heavy virtualized grids, drag-drop deckbuilding, and XLSX/PDF export. The one genuine Electron trap is electron-builder's `portable` target, which re-extracts ~350 MB to `%TEMP%` on **every single launch** (documented reports up to ~60s on AV-scanned/HDD machines) — the fix is to ship a ZIP'd unpacked directory instead and only offer the portable .exe as a secondary convenience build. Recommendation: **Electron 43 + electron-vite 5 + Vite 7 + React 19 + better-sqlite3 13, distributed as ZIP-first**, with Tauri 2.11 as the fallback only if a ~10 MB binary is a hard product requirement, .NET 10 + Avalonia 12 if the dev is primarily a C# developer or headless UI testing is top-3, and Flutter ruled out (no single-exe, Impeller still not shipped on Windows, licensed-vendor dependency for Excel).

## Details

> Raw research data, verified 2026-08-04. Live registry/API queries unless noted. Working dir `D:\Code\mtg-collection` is empty except `.git` — greenfield, no existing constraints.

---

# 0. CORRECTIONS TO THE BRIEF

Three premises in the task are out of date and should be fixed in the design doc before anything else:

| Brief says | Reality (2026-08-04) | Impact |
|---|---|---|
| "~500MB JSON file" | Scryfall serves **gzipped JSONL only** since 2026-07-20. Bulk objects expose `jsonl_download_uri` + `compressed_size`; `download_uri` and `size` fields are **gone**. | Removes the "giant JSON.parse" risk entirely. Streaming NDJSON ingest in all 4 stacks. Neutralizes Rust/.NET parsing advantage. |
| ".NET 8/9" | **.NET 8 and .NET 9 both EOL 2026-11-10.** .NET 10 is the current LTS (released 2025-11-11, EOL 2028-11-10). .NET 11 STS lands Nov 2026. | Target .NET 10. Shipping on 8 or 9 means an out-of-support runtime within 3 months. |
| "100-160k card records" | `default_cards` = **105,651** prints. `all_cards` (all languages) is the 400k+ / 2.6 GB tier. `oracle_cards` = 33,514 unique. | 105k is the right working number; 160k only if you add non-English or `all_cards`. |

---

# 1. VERIFIED VERSION MATRIX (2026-08-04)

## Electron stack
| Package | Version | Date | Note |
|---|---|---|---|
| electron | **43.2.0** (`latest`) | 2026-07-21 | Chromium 150.0.7871.129, **Node 24.18.0**, V8 15.0.1240245 |
| electron | 42.8.0 | 2026-07-28 | prior stable line, still supported |
| electron | 44.0.0 | stable **2026-08-25** | M152 / Node 24.18.1; 8-week major cadence |
| electron-builder | 26.15.7 (`v26` tag) / 26.15.3 (`latest` tag) | 2026-07-18 / 06-09 | ⚠ `latest` dist-tag lags `v26` — pin explicitly |
| electron-builder | 27.0.0-alpha.6 | 2026-07-24 | next major, alpha |
| electron-vite | **5.0.0** | 2025-12-07 | peer `vite: ^5 \|\| ^6 \|\| ^7` — **does not accept Vite 8** |
| electron-vite | 6.0.0-beta.1 | 2026-04-12 | peer `vite: ^6 \|\| ^7 \|\| ^8` — beta only |
| vite | 8.2.0 (`latest`) / 7.3.6 (`previous`) | 2026-07-30 / 06-25 | **use 7.3.6** to stay on stable electron-vite 5 |
| react | 19.2.8 | 2026-07-21 | |
| typescript | 7.0.2 | 2026-07-08 | GA. Go-native (`tsgo`, "Project Corsa"), 8-12x faster; VS Code full check 125.7s → 10.6s |
| typescript | 6.0.3 | 2026-04-16 | last JS-based compiler |
| better-sqlite3 | **13.0.2** | 2026-07-29 | see §2 |
| @tanstack/react-virtual | 3.14.9 | 2026-07-28 | |
| react-virtuoso | 4.18.11 | 2026-07-17 | |
| react-window | 2.3.0 | 2026-07-20 | |
| ag-grid-community | 36.0.2 (MIT) | 2026-07-22 | enterprise 36.0.2 is `Commercial` |
| @atlaskit/pragmatic-drag-and-drop | 2.0.1 | 2026-06-17 | actively maintained |
| @dnd-kit/core | 6.3.1 | **2024-12-05** | v1 line stagnant ~20 months |
| @dnd-kit/react + @dnd-kit/dom | 0.5.0 | 2026-06-11 | v2 rewrite, still **0.x** |
| exceljs | 4.4.0 | **2023-10-19** | stale but still the de-facto pick |
| write-excel-file | 4.1.1 | 2026-06-08 | actively maintained, **write-only** |
| pdfmake | 0.3.11 | 2026-06-12 | |
| @react-pdf/renderer | 4.5.1 | 2026-04-15 | |
| vitest | 4.1.10 | 2026-07-06 | |
| playwright / @playwright/test | 1.62.1 | 2026-07-30 | |
| electron-playwright-helpers | 2.1.0 | 2025-12-28 | |
| drizzle-orm / kysely | 0.45.2 / 0.29.4 | 2026-03-27 / 07-17 | |
| electron-updater / electron-log | 6.8.9 / 5.4.4 | 2026-06-05 / 05-14 | |
| zod | 4.4.3 | 2026-05-04 | |

⚠ **SheetJS `xlsx` is a trap.** SheetJS left the npm registry over a dispute; npm's `xlsx` is frozen at 0.18.5 with 2 unfixed high-severity advisories (ReDoS, prototype pollution). Current releases are CDN-only at `cdn.sheetjs.com`. Use `exceljs` or `write-excel-file`.

## Tauri stack
| Package | Version | Date |
|---|---|---|
| tauri (crate) | **2.11.5** | 2026-07-01 |
| tauri-cli | 2.11.4 | 2026-06-28 |
| @tauri-apps/api | 2.11.1 | 2026-06-17 |
| tauri-plugin-sql (crate/npm) | 2.4.0 | 2026-04-04 |
| rusqlite | 0.40.1 | 2026-06-06 |
| libsqlite3-sys | 0.38.1 | 2026-06-06 |
| sqlx | 0.9.0 | 2026-05-21 |
| serde_json / simd-json | 1.0.151 / 0.17.3 | 2026-07-20 / 07-09 |
| rust_xlsxwriter | 0.97.0 | 2026-07-30 |
| calamine (xlsx read) | 0.36.1 | 2026-07-27 |
| printpdf | 0.12.5 | 2026-07-29 |
| WebView2 Runtime | 150.0.4078.x | 2026-07-28 |

## .NET stack
| Package | Version | Note |
|---|---|---|
| .NET | **10 (LTS)** | released 2025-11-11, EOL 2028-11-10 |
| Avalonia / Avalonia.Desktop | **12.1.1** | v12 = composition renderer by default |
| Avalonia VS extension | 12.0 | 2026-04-10 |
| CommunityToolkit.Mvvm | 8.4.2 | |
| Microsoft.Data.Sqlite | 10.x stable (11.0.0-preview.6 tracks .NET 11) | |
| ClosedXML | 0.105.1 | **MIT** |
| QuestPDF | 2026.7.2 | Community MIT: free **only** if annual gross revenue < $1M **and** not public-sector **and** not publicly traded |
| Microsoft.Web.WebView2 | 1.0.4129.50 | |

## Flutter stack
| Package | Version | Date | Note |
|---|---|---|---|
| Flutter SDK | 3.44.x | 2026-07 | |
| drift | 2.34.3 | 2026-07-27 | healthy |
| sqlite3 (dart) | 3.5.0 | 2026-07-18 | now bundles libs itself |
| sqlite3_flutter_libs | **0.6.0+eol** | 2026-02-15 | ⚠ **RETIRED** — "Not used anymore, update to version 3.x of package:sqlite3" |
| pdf | 3.13.0 | 2026-06-16 | healthy |
| excel | 4.0.6 | **2024-08-20** | stale |
| syncfusion_flutter_xlsio | 34.1.33 | 2026-07-28 | ⚠ Syncfusion Community License (< $1M rev, ≤5 devs) or paid |
| super_drag_and_drop | 0.9.1 | **2025-06-11** | pre-1.0 |
| cached_network_image | 3.4.1 | **2024-08-13** | stale |
| flutter_staggered_grid_view | 0.7.0 | **2023-07-30** | 3 years stale |

## Other
| | Version | Date | Verdict |
|---|---|---|---|
| Wails | **v3.0.0-beta.0** → beta.3 | 2026-08-02 → 08-03 | Beta shipped **2 days ago**. v2 still stable line. Too fresh. |
| Neutralino | 6.4.0 | | `neu build --embed-resources` (postject) → single binary; thin OS API, no native SQLite story |

---

# 2. better-sqlite3 13.0.2 — THE DECISION-CHANGING FINDING

Downloaded and inspected the npm tarball (11,417,680 bytes, 68 files):

```
package/prebuilds/win32-x64.node        1,989,632 bytes
package/prebuilds/win32-arm64.node      1,903,104 bytes
package/prebuilds/darwin-arm64.node     1,980,736
package/prebuilds/darwin-x64.node       1,982,880
package/prebuilds/linux-x64.node        2,226,168
package/prebuilds/linux-arm64.node      2,117,320
package/prebuilds/linuxmusl-x64.node    2,435,680
package/prebuilds/linuxmusl-arm64.node  2,312,112
```

`package.json`: `dependencies: {"node-addon-api": "^8.0.0"}`, `engines: {"node": ">=22"}`, **no `binary` field**, **no `prebuild-install`**.
`binding.gyp`: `'defines': ['NAPI_VERSION=10', ...]`, and `'prebuild_exists%': '<!(node lib/binding.js)'` — the gyp build is skipped entirely when a prebuild matches the host.

**Consequences:**
- **No node-gyp. No `@electron/rebuild`. No Visual Studio Build Tools.** Not on the dev machine, not in CI. This was historically the #1 reason people fled Electron for this exact class of app. It is gone.
- N-API 10 ⇒ the same `.node` binary works across Node 22/24/26 **and** Electron 42/43/44 without recompiling. Electron major upgrades no longer break the DB layer.
- Contrast: Tauri's `rusqlite` with the `bundled` feature still requires a **C compiler (MSVC)** plus the whole Rust toolchain. Tauri does not escape the native-toolchain requirement; it just relocates it.

**SQLite compile flags in the shipped prebuild** (from `deps/defines.gypi`) — all verified enabled:
```
SQLITE_ENABLE_FTS5          ← full-text search on name/type_line/oracle_text: available out of the box
SQLITE_ENABLE_FTS3, FTS4, FTS3_PARENTHESIS
SQLITE_ENABLE_JSON1         ← query the raw stored card JSON directly
SQLITE_ENABLE_RTREE, GEOPOLY
SQLITE_ENABLE_STAT4         ← better query plans on skewed card data
SQLITE_ENABLE_MATH_FUNCTIONS, PERCENTILE, COLUMN_METADATA, DBSTAT_VTAB, DESERIALIZE
SQLITE_DEFAULT_CACHE_SIZE=-16000   ← 16 MB page cache already default
SQLITE_DEFAULT_FOREIGN_KEYS=1
SQLITE_DEFAULT_WAL_SYNCHRONOUS=1
SQLITE_DQS=0                ← strict: no double-quoted string literals
SQLITE_THREADSAFE=2         ← multi-thread mode (one connection per thread)
SQLITE_OMIT_SHARED_CACHE
```
Bundled SQLite = **3.53.4** (per v13.0.2 release notes, 2026-07-29).

`SQLITE_THREADSAFE=2` matters: one connection per thread/process. Do not share a `Database` handle across `utilityProcess` boundaries.

---

# 3. DATA SOURCE: SCRYFALL (live-verified 2026-08-03/04)

`GET https://api.scryfall.com/bulk-data` returns objects with **`jsonl_download_uri` + `compressed_size` only**. No `download_uri`, no `size`.

| type | compressed (gz) | est. raw | rows |
|---|---|---|---|
| `oracle_cards` | 24.4 MB | ~160 MB | **33,514** |
| `unique_artwork` | 37.3 MB | ~250 MB | ~48k |
| **`default_cards`** | **77.3 MB** | **~500 MB** | **105,651** |
| `all_cards` | 390.1 MB | ~2.6 GB | 500k+ (all languages) |
| `rulings` | 5.3 MB | ~35 MB | |
| `art_tags` / `oracle_tags` | 12.4 / 5.9 MB | | |

Sets endpoint: **1,047** sets.
`HEAD` on the default-cards file confirms `Content-Length: 77332681`, `Accept-Ranges: bytes` (resumable), `Content-Type: application/gzip`, ETag + Last-Modified (cheap freshness check).

**Card object shape:** 66 top-level fields. `image_uris` now has **11 keys**: `small, normal, large, png, art_crop, border_crop` (JPEG/PNG) + `thumb, grid, display, art, crop` (**WebP** — new, smaller).

**Scryfall policy (hard constraints for the design doc):**
- Sustained traffic **< 10 req/s**, 50–100 ms delay between calls. `/cards/collection` hard cap **2/s** (500 ms).
- Descriptive `User-Agent` **required** with contact info; generic UAs (`curl`, `python-requests`) are routinely blocked. `Accept: application/json` required.
- Bulk files are mandatory for mass lookups/images — do not paginate live endpoints.
- Cache locally **at least 24h**; bulk exports are the canonical refresh mechanism.

**Image cache math (105,651 cards, front faces only):**
- `thumb`/`grid` WebP @ ~8–12 KB → **~1.0–1.3 GB**
- `small` JPEG @ ~10 KB → ~1.1 GB
- `normal` JPEG @ ~60–70 KB → **~6.5–7.4 GB**
→ Design: cache WebP `grid`/`small` eagerly for the grid, fetch `normal`/`large` lazily on card detail only. At 10 req/s a full small-image warm is ~3 hours — must be a resumable background job, never a blocking first-run step.

**Ingest cost estimate (all stacks, once per week):** gunzip 77 MB ≈ 1–2 s; parse ~500 MB NDJSON — Node `JSON.parse` per-line ≈ 300–600 MB/s → 1–3 s; better-sqlite3 prepared insert in **one transaction** ≈ 50k–200k rows/s → 105k rows in ~1–4 s. **End-to-end ~8–25 s including download.** Rust w/ `simd-json` would cut parse maybe 2–4x, saving ~1–2 s on a weekly background task. **Not a differentiator.**

---

# 4. OPTION 1 — Electron 43 + electron-vite + React 19 + TS + better-sqlite3 13

## 4a. Portability on Windows — the `portable` target, in detail

`electron-builder` `portable` target = an **NSIS self-extracting archive**. Mechanics:

1. User double-clicks `MtgCollection.exe`.
2. NSIS wrapper extracts the entire app payload to `%LOCALAPPDATA%\Temp\<guid>.tmp\` (default: a build-uuid dir, regenerated on every build).
3. Wrapper sets env vars, then spawns the real Electron exe from TEMP.
4. **Extraction happens on every launch, not once.** Unlike an installer, the unpack cost is never amortized.

**PortableOptions:**
| Option | Behavior |
|---|---|
| `unpackDirName: string` | Fixed name under `%TEMP%` → OS keeps files, subsequent launches are fast. ⚠ **electron-builder issue #7870: launching a second instance with `unpackDirName` set crashes the first instance.** |
| `unpackDirName: false` | Uses NSIS `$PLUGINSDIR`, unique per launch → correct, but pays full extraction every time. |
| `unpackDirName` (default) | build uuid — changes each build, so every rebuild orphans a temp dir. |
| `splashImage: string` | **.bmp only.** Shown during extraction. Cosmetic only. |
| `useZip: boolean` | Zip (Deflate) instead of LZMA → faster extraction, larger exe. |
| `requestExecutionLevel` | `user` / `highest` / `admin` |

**Env vars set by the wrapper (must use these — `process.execPath` points into TEMP):**
- `PORTABLE_EXECUTABLE_DIR` — directory containing the original .exe
- `PORTABLE_EXECUTABLE_FILE` — full path of the original .exe
- `PORTABLE_EXECUTABLE_APP_FILENAME`

## 4b. Size and startup — hard numbers

- `electron-v43.2.0-win32-x64.zip` = **144,326,439 bytes (144.3 MB)** compressed (verified via GitHub release Content-Length). Unpacked ≈ **320–360 MB**.
- Plus app bundle (~2–10 MB) + `better_sqlite3.node` (1.99 MB).
- Realistic **portable .exe (LZMA) ≈ 95–120 MB**; extracted footprint ≈ **340–380 MB**.
- **Startup:** writing/decompressing ~350 MB to `%TEMP%` per launch. NVMe with AV exclusions: ~2–5 s. Spinning disk, or Defender real-time scanning a fresh 350 MB temp tree: 10–60 s. electron-builder issue #5765 is exactly this; users report *"about a minute to load on some computers."*

**→ This is the single biggest risk in the entire Electron plan, and it is avoidable.**

## 4c. Recommended distribution: ZIP-first, portable-exe-second

Ship `target: zip` (or `dir`) as the primary artifact. User extracts once to `D:\Apps\MtgCollection\` (or a USB stick) and runs `MtgCollection.exe`. Launch is then normal Electron cold start (**~600 ms–1.5 s**), no temp churn, DB and 1+ GB image cache live next to the exe where the user can see and back them up. This is what VS Code Portable and most real portable apps do. Offer the `portable` .exe as a labeled convenience build for people who insist on one file.

```yaml
# electron-builder.yml
appId: com.example.mtgcollection
asar: true
asarUnpack:
  - "**/node_modules/better-sqlite3/**"      # .node cannot be reliably dlopen'd from inside asar
npmRebuild: false                             # N-API prebuilds: nothing to rebuild
win:
  target:
    - { target: zip,      arch: [x64] }       # PRIMARY
    - { target: portable, arch: [x64] }       # secondary convenience
    - { target: nsis,     arch: [x64] }       # optional installed mode
portable:
  unpackDirName: false                        # correctness > speed; ZIP is the fast path
  splashImage: build/splash.bmp
```

## 4d. Where app data lives (portable)

In `main`, **before `app.whenReady()`** (`setPath` for `userData` must precede ready):

```ts
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

function resolveDataDir(): string {
  const exeDir = process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'));
  const candidate = path.join(exeDir, 'data');
  try {
    fs.mkdirSync(candidate, { recursive: true });
    fs.accessSync(candidate, fs.constants.W_OK);
    return candidate;                                  // portable mode
  } catch {
    return path.join(app.getPath('appData'), 'MtgCollection');  // read-only USB / Program Files
  }
}

const dataDir = resolveDataDir();
app.setPath('userData',    dataDir);
app.setPath('sessionData', path.join(dataDir, 'session'));
app.setPath('logs',        path.join(dataDir, 'logs'));
// DB:     path.join(dataDir, 'collection.db')
// Images: path.join(dataDir, 'images')
```

The write-probe fallback is essential — a "portable" exe dropped in `C:\Program Files\` or on a read-only share must degrade gracefully, not crash on first write.

## 4e. Architecture notes specific to this app

**Ingest off the UI thread:** use **`utilityProcess.fork()`**, not `worker_threads`. Electron issue #43513 (better-sqlite3 unresolvable in `worker_thread` in packaged/asar builds — closed, but path resolution remains fiddly). `utilityProcess` is a real Node child process with full native-module support and a `MessagePort` back to main. Pipeline: `fetch(jsonl_download_uri)` → `zlib.createGunzip()` → `readline` → batched prepared inserts inside one transaction → progress messages to the renderer.

**Local images into the renderer:** register a privileged custom scheme, **not** `file://`:
```ts
protocol.registerSchemesAsPrivileged([{
  scheme: 'mtg',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
}]);
// then in whenReady:
protocol.handle('mtg', (req) => net.fetch(pathToFileURL(resolveCachePath(req.url)).toString()));
```
`stream: true` gives Range support, which matters when the grid is firing hundreds of concurrent image requests.

**Schema:** hot columns as real columns (`id, oracle_id, name, set_code, collector_number, cmc, type_line, rarity, colors, color_identity, released_at, price_usd, image_grid_id`) + `raw JSON` TEXT column for the other ~50 fields; FTS5 external-content virtual table over `name, type_line, oracle_text`. `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` (cache_size already 16 MB).

## 4f. Ecosystem fit — the actual reason to pick this

| Need | Option | State |
|---|---|---|
| Virtualized image grid | `@tanstack/react-virtual` 3.14.9 | Best-in-class; windowed + dynamic measurement + horizontal/grid |
| " | `react-virtuoso` 4.18.11 | `VirtuosoGrid` is purpose-built for this exact case |
| " | `ag-grid-community` 36.0.2 (MIT) | For the *tabular* collection view; enterprise features are `Commercial` |
| Drag-drop deckbuilder | `@atlaskit/pragmatic-drag-and-drop` 2.0.1 | Actively maintained, framework-agnostic, uses native HTML5 DnD, tiny |
| " | `@dnd-kit/react` 0.5.0 | Nicer API but **0.x**; `@dnd-kit/core` 6.3.1 has been static since Dec 2024 |
| XLSX export | `exceljs` 4.4.0 | Stale (2023) but works and is the ecosystem default |
| " | `write-excel-file` 4.1.1 | Actively maintained, write-only — good fit since you only export |
| CSV | trivial / `papaparse` | |
| PDF (proxy sheets, deck lists) | `pdfmake` 0.3.11 or `@react-pdf/renderer` 4.5.1 | `@react-pdf` lets you compose the PDF in JSX with the same card components |

## 4g. Testing story

- **Unit:** Vitest 4.1.10. Renderer logic + main-process modules. better-sqlite3 against `:memory:` is *synchronous* — test setup/teardown is trivial and fast, no async DB fixtures. This is a genuine testability win over async drivers.
- **Component:** Vitest + Testing Library, or Vitest browser mode.
- **E2E:** Playwright 1.62.1 `_electron.launch()`. Labeled "experimental" but VS Code depends on it and it has had no breaking changes. **Known limits:** cannot intercept `dialog.showOpenDialog` / `showSaveDialog` / `showMessageBox` (main-process → OS APIs), and cannot touch native chrome. Workaround: a test-mode IPC channel that injects fake file paths. `electron-playwright-helpers` 2.1.0 helps with menu/IPC stubbing.

## 4h. Risks
1. **Portable-target extraction cost** — mitigated by ZIP-first (§4c). If you ship only the `portable` exe you will get "the app takes a minute to start" bug reports.
2. **Version-pin friction:** electron-vite 5.0.0 peer-caps at Vite 7. Vite 8.2.0 requires electron-vite 6.0.0-beta.1. **Pin Vite 7.3.6 + electron-vite 5.0.0.**
3. **TypeScript 7 tooling gap:** TS 7.0.2 has **no stable programmatic API** until 7.1 — `typescript-eslint`, `ts-jest`, `ts-morph`, and template checkers cannot run on it. Either stay on 6.0.3, or run 7.0.2 for `tsc --noEmit` speed while keeping 6.0.3 for lint tooling.
4. **electron-builder dist-tag confusion:** `latest` = 26.15.3 while `v26` = 26.15.7. Pin an exact version.
5. **8-week Electron majors** — Chromium churn. N-API prebuilds mean the DB layer no longer breaks on upgrade, which removes most of the sting.
6. **RAM:** 150–300 MB baseline before card images. Image cache in renderer must be bounded (LRU) or a 105k-card scroll will balloon it.

---

# 5. OPTION 2 — Tauri 2.11 + React/TS

## 5a. WebView2 availability
- **Windows 11: preinstalled on all devices**, part of the OS.
- **Windows 10 1803+**: Microsoft pushed the Evergreen Runtime to all *eligible* devices (Nov 2022 update). Gaps that persist in 2026: **Win10 LTSC/LTSB**, **Windows Server**, some managed/imaged corporate builds, clean-install Win10 images.
- Current runtime 150.0.4078.x (2026-07-28), x86/x64/ARM64.

The residual gap is small but it is *precisely* the failure mode that breaks the app's core promise: a "portable exe" that shows a blank window on the one machine that doesn't have WebView2 is worse than a 100 MB exe that always works.

## 5b. Portability — the honest picture
Tauri **officially does not support a portable mode**. Documented bundle targets are `.msi` (WiX v3) and NSIS `-setup.exe` only.

However — `src-tauri/target/release/app.exe` **does run standalone**, because the bundler inlines the frontend assets into the binary as static data + runtime lookup structures. Verified conditions and caveats from maintainer discussions (#3048, #9884, #11167):
- ✅ Works if: no `resources`, no sidecars, no updater, target machine has **WebView2** *and* **VC++ Redistributable**.
- ❌ Breaks: `resources`/sidecar features; the updater (it downloads the MSI); notification/dialog icons render as the **PowerShell icon**; no signed-installer story.
- Maintainer verdict: *"this .exe is typically not shippable as-is."*
- **No cross-compilation** — you must build on Windows.

Size: hello-world ≈ **3 MB**; a real app with rusqlite bundled + a React bundle ≈ **8–15 MB**.

**The WebView2 escape hatches all destroy the size advantage:**
| `webviewInstallMode` | Added size | Works offline | Single exe |
|---|---|---|---|
| `downloadBootstrapper` (default) | 0 MB | ❌ | installer only |
| `embedBootstrapper` | ~1.8 MB | ❌ | installer only |
| `offlineInstaller` | **~127 MB** | ✅ | installer only |
| `fixedVersion` | **~180 MB** | ✅ | **folder next to exe, not embedded** |
| `skip` | 0 MB | — | not recommended |

If you need guaranteed-works portability you land at ~180 MB in a folder — i.e. **worse than the Electron ZIP** while keeping all of Tauri's complexity.

## 5c. SQLite: `tauri-plugin-sql` vs `rusqlite` command layer

| | `tauri-plugin-sql` 2.4.0 | `rusqlite` 0.40.1 in `#[tauri::command]` |
|---|---|---|
| Backend | `sqlx` (SQLite/MySQL/Postgres) | direct SQLite |
| API | JS `Database.load()`, `db.execute()`, `db.select()`, `db.close()` | your own typed commands |
| Params | `$1` positional | `?`/named |
| Migrations | ✅ built-in, all in one transaction | roll your own (or `refinery`) |
| Perms | reads default-allowed; writes need `allow-execute` | your own |
| Bulk ingest | ❌ **every row crosses IPC as JSON, twice** | ✅ entirely in Rust, nothing crosses |
| Prepared-stmt reuse | not exposed | ✅ |
| Streaming | ❌ | ✅ via `Channel` |
| Min Rust | 1.77.2 | |

**Verdict: `rusqlite` command layer.** `tauri-plugin-sql` is fine for small CRUD, wrong for a 105k-row ingest driven from JS. Do the whole ingest in Rust (`reqwest` → `flate2` → `BufRead::lines()` → `serde_json`/`simd-json` → one prepared insert in one transaction) and emit progress via `Channel`.

Also worth noting: forks exist (`tauri-plugin-rusqlite2`, `tauri-plugin-sqlite`) but they're third-party forks-of-forks — extra supply-chain surface for no gain over writing ~200 lines of commands yourself.

## 5d. IPC boundary
Tauri v2 serializes all IPC payloads as **JSON by default**. Measured: a 64 KB payload roundtrips in **~6.7 ms** JSON vs **~600 µs** with raw bytes. v2 does provide `ipc::Response` (returns `Vec<u8>`) and `Channel` for push-streaming, but **no codec layer** — framing/sequencing/batching and the matching JS decoder are yours to write.

Practical impact: a virtualized grid pulling 100–500 card rows per page is fine over JSON. Shipping 105k rows to JS is not. You must page rigorously. Electron's structured-clone IPC has no equivalent JSON tax.

## 5e. Images
`convertFileSrc()` + `asset:` protocol. Requires **both**: `asset:` and `http://asset.localhost` added to `app.security.csp`, **and** `app.security.assetProtocol.enable = true` with an explicit `scope` array. Runtime paths outside the scope are refused by the WebView. For a user-relocatable portable image cache the scope must be broad or dynamically extended — a config footgun.

## 5f. Build & dev velocity
- Requires: Rust toolchain + **MSVC build tools** + WebView2 SDK. (So Tauri does *not* avoid the native-toolchain requirement — Electron now does.)
- Cold `cargo build --release`: typically **3–10 min**. Incremental Rust edits: 20–90 s.
- Frontend HMR is unaffected (Vite) — UI iteration is as fast as Electron. The tax lands on backend/data-layer iteration, which for this app is a lot of the work (ingest, search, price history, export).
- Two languages, two mental models, one FFI boundary in between.

## 5g. Ecosystem fit
Frontend: identical to Electron (TanStack Virtual, pragmatic-dnd, etc.). Backend export libs are Rust-side: `rust_xlsxwriter` 0.97.0 (excellent, actively developed), `printpdf` 0.12.5 (workable but far less ergonomic than `@react-pdf/renderer`), `calamine` 0.36.1 for import. Alternatively keep exports in JS and reuse `exceljs`/`pdfmake` — but then you're streaming the data across the JSON IPC boundary to do it.

## 5h. Testing
- **Rust unit tests: excellent.** `cargo test`, in-process, fast, and the entire data layer lives there.
- **Frontend unit: Vitest**, same as Electron.
- **E2E: `@wdio/tauri-service` + `tauri-driver` + `msedgedriver`.** Documented fragility: **msedgedriver version must match the installed Edge/WebView2 version**, and WebView2 auto-updates — so E2E can break on a Tuesday for reasons unrelated to your code. Requires a debug build. ⚠ Playwright cannot drive Tauri on Windows (engine mismatch — Playwright ships its own Chromium, Tauri uses system WebView2).

## 5i. Risks
1. Portable mode is unsupported-but-works; you're relying on undocumented behavior for the app's headline requirement.
2. WebView2 absence has no in-band remedy in a raw-exe distribution.
3. JSON IPC tax on every data path; you design around it forever.
4. Rust + MSVC toolchain, no cross-compile, 3–10 min release builds.
5. E2E harness coupled to Edge's auto-update cadence.
6. Two-language codebase for a solo/small-team hobby-scale project.

---

# 6. OPTION 3 — .NET 10 + Avalonia 12 (or WPF)

## 6a. Single-file publish — verified behavior
```bash
dotnet publish -r win-x64 -c Release --self-contained true \
  -p:PublishSingleFile=true \
  -p:IncludeNativeLibrariesForSelfExtract=true \
  -p:PublishReadyToRun=true
```
Per Microsoft docs: **managed DLLs are extracted and loaded in memory (no disk extraction)**, but **native binaries of the core runtime are separate files** unless `IncludeNativeLibrariesForSelfExtract=true`. With that flag, natives (including SQLitePCLRaw's `e_sqlite3.dll`) are extracted to disk:
1. `DOTNET_BUNDLE_EXTRACT_BASE_DIR` if set, else
2. `%TEMP%\.net\<app>\<hash>\` on Windows.

**Critically: extraction is keyed by content hash — it happens once per version, not once per launch.** This is fundamentally better than electron-builder's `portable`. And you can pin `DOTNET_BUNDLE_EXTRACT_BASE_DIR` next to the exe to keep everything on the USB stick.

(For contrast: the WinUI 3 unpackaged single-file path *requires* `IncludeAllContentForSelfExtract=true` and is explicitly documented as "not a zero-extraction binary." Avalonia is in better shape here.)

## 6b. Size
- Minimal Avalonia self-contained single-file, trimmed: **~58 MB unzipped / ~25 MB zipped**.
- With ReactiveUI + real dependency set: **~70–90 MB**.
- NativeAOT (`-p:PublishAot=true`): **~26–40 MB**. ⚠ AOT force-enables trimming, and Avalonia's XAML + bindings are reflection-heavy — requires careful `DynamicDependency` attributes / ILLink descriptor files. Community consensus: risky for a large app; expect runtime "control not found" failures that only appear in the published build.

## 6c. UI fit
- **Avalonia 12.1.1** ships the composition-based renderer as default — meaningful perf gain over 11.x.
- **Virtualized image grid:** `ItemsRepeater` + `UniformGridLayout`. Docs explicitly recommend `ItemsRepeater` over `ListBox` for 10,000+ items. ⚠ Virtualization silently disables if the control is nested in something granting infinite height (`ScrollViewer`/`StackPanel`) — a classic and hard-to-spot bug.
- **Tabular view:** `TreeDataGrid` (rewritten, virtualized, better than the older `DataGrid`).
- **Drag-drop:** `DragDrop.DoDragDrop` + manual adorners. Functional but there is **no dnd-kit/pragmatic-dnd equivalent** — reorder animations, drop indicators, multi-drag, keyboard accessibility are all hand-built.
- **The gap is dev velocity for a rich, iterated, image-heavy UI.** No CSS, no Tailwind, no npm component ecosystem, no Vite-class HMR (XAML hot reload exists but is weaker). Foil effects, mana-symbol inline rendering, hover-preview cards, set-symbol sprites — all bespoke.

## 6d. Export
- **Excel: ClosedXML 0.105.1, MIT.** Mature, no licensing questions. Best export story of the four.
- **PDF: QuestPDF 2026.7.2.** Excellent fluent API. ⚠ **Community MIT is conditional**: free under $1M annual gross revenue, with a 90-day transition if you cross it, and **explicitly excluded** for public-sector entities and publicly traded companies *regardless of revenue*. Self-attested, no audit clause. For a personal collection tracker this is a non-issue — but it must be recorded in the design doc. Alternatives: PdfSharpCore, or SkiaSharp-based rendering.

## 6e. Testing — best of the four
- xUnit/NUnit + `dotnet test`. No browser, no Electron harness, no WebDriver, no version-drift flakiness.
- **`Avalonia.Headless` + `Avalonia.Headless.XUnit`** gives real in-process headless UI tests: instantiate windows, dispatch input, assert on the visual tree. Nothing in the web stacks matches this for speed × fidelity.
- Ingest/DB/export logic is plain C# — trivially unit-testable.
- Startup: ~200–500 ms with ReadyToRun. RAM: ~60–120 MB. Both far better than Electron.

## 6f. WPF variant
Windows-only (acceptable here). Also supports self-contained single-file on .NET 10. Larger, older ecosystem; better third-party control market (though mostly paid). Avalonia's renderer is better suited to an image-heavy grid. **Only pick WPF if the developer already knows WPF well** — otherwise Avalonia is strictly the better modern choice.

## 6g. Risks
1. **Dev velocity on the UI is the dominant cost of this option**, and this app is ~70% UI.
2. Trimming/AOT vs. reflection-based XAML — publish-only failures.
3. QuestPDF license conditions.
4. Avalonia 12 is recent (v12 line began early 2026); 11.x is the battle-tested line.
5. Virtualization silently disabling under infinite-height parents.

---

# 7. OPTION 4 — Flutter desktop

## 7a. Portability
No first-party single-file exe. `build\windows\x64\runner\Release\` contains:
```
mtg_collection.exe
flutter_windows.dll
msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll
data\  (assets, icudtl.dat, app.so — AOT payload)
```
Zip-and-run works; you must ship the whole folder. Documented common failure: **exe built on a dev machine fails on other PCs with missing `VCRUNTIME140.dll`** — you must explicitly copy the VC++ redist DLLs into the release folder. Wrapping into one exe requires third-party packers (Enigma Virtual Box etc.), which reintroduces per-launch extraction.

## 7b. Rendering — the disqualifier for this app
Flutter Windows desktop **still uses Skia + OpenGL/ANGLE, not Impeller**, as of 3.44.x. The Impeller Vulkan backend for Windows/Linux is a **2026 roadmap item, design-doc stage (flutter/flutter#183495), not shipped**. The documented consequence of Skia+ANGLE on Windows is **runtime shader variant compilation causing first-frame jank** — which is exactly the failure mode of a fast-scrolling, image-heavy card grid. This is the app's single hottest code path.

## 7c. Ecosystem fit — weakest of the four
| Need | Package | State |
|---|---|---|
| SQLite | `drift` 2.34.3 + `sqlite3` 3.5.0 | ✅ Genuinely good — typed, migrations, isolate-based, actively maintained |
| ⚠ | `sqlite3_flutter_libs` **0.6.0+eol** | **RETIRED** 2026-02-15 — "Not used anymore, update to version 3.x of package:sqlite3" |
| Virtualized grid | `GridView.builder` | ✅ built-in, virtualizes fine |
| " | `flutter_staggered_grid_view` 0.7.0 | ❌ last release **2023-07-30** |
| Images | `cached_network_image` 3.4.1 | ⚠ last release 2024-08; you'll likely write your own disk cache |
| Drag-drop (OS) | `super_drag_and_drop` 0.9.1 | ⚠ pre-1.0, last release 2025-06 |
| Drag-drop (in-app) | `Draggable`/`DragTarget` | ✅ built-in, but all deckbuilder interactions hand-built |
| PDF | `pdf` 3.13.0 | ✅ solid, active |
| Excel | `excel` 4.0.6 | ❌ stale (2024-08) |
| " | `syncfusion_flutter_xlsio` 34.1.33 | ⚠ active, but **Syncfusion license** (free < $1M rev & ≤5 devs, else paid) |

## 7d. Testing — strong
`flutter test` widget tests are fast and in-process; `integration_test` for e2e. Comparable to .NET, better than Electron/Tauri for UI-level assertions.

## 7e. Dev velocity
Hot reload is best-in-class. But Dart + widget trees is a distinct mental model with **no CSS**; every visual affordance is rebuilt. Size ~40–80 MB folder, RAM ~80–150 MB, startup ~300–800 ms.

## 7f. Verdict
Only compelling if **mobile companion apps are a near-term goal**. For a Windows-first portable desktop tracker it loses on portability (no single exe), rendering (Impeller not shipped), and ecosystem depth (stale/EOL/licensed packages across three of the five required capabilities).

---

# 8. OTHER CREDIBLE OPTIONS

**Wails v3** — `v3.0.0-beta.0` shipped **2026-08-02**, `beta.3` on **2026-08-03** (two days before this research). v2 remains the stable line. Go + system WebView2, ~10–20 MB single binary, first-class multi-window, static-analysis-generated TypeScript bindings. DB via `mattn/go-sqlite3` (cgo) or **`modernc.org/sqlite` (pure Go, no cgo)** — the latter is genuinely attractive for a true zero-toolchain single-file exe. Same WebView2 dependency as Tauri. Go's ingest performance and single-binary story are excellent. **Verdict: too fresh to bet a project on this month. Revisit in 6–12 months** — it may become the best answer for this exact use case.

**Neutralino 6.4.0** — `neu build --embed-resources` embeds `resources.neu` into the platform binary via `postject`. ~1 MB base. But: thin OS API surface, **no native SQLite story**, no native-module ecosystem. Suited to "lightweight utility around an existing web UI." **Not suitable** for a 105k-row local database with image caching and export.

---

# 9. RANKED RECOMMENDATION FOR THIS APP

### 🥇 1. Electron 43 + electron-vite 5 + Vite 7 + React 19 + TypeScript + better-sqlite3 13 — **shipped as a ZIP'd unpacked directory**

The two standing objections to Electron for this app both got materially weaker in 2026:
- **Native module pain: eliminated.** better-sqlite3 13.0.2's N-API prebuilds (`prebuilds/win32-x64.node`, verified present in the tarball) mean no node-gyp, no `@electron/rebuild`, no VS Build Tools, and no rebreakage on Electron major upgrades. Tauri and .NET both still require a full native toolchain (MSVC).
- **The "500 MB JSON" scare: obsolete.** Scryfall is JSONL-only since 2026-07-20. Streaming ingest is ~15 lines of Node, runs in a `utilityProcess`, completes in 8–25 s, once a week. Rust would save ~1–2 s.

What's *left* to differentiate is precisely where the web ecosystem is 5–10x deeper than the alternatives: TanStack Virtual / Virtuoso for a 105k-item image grid, pragmatic-drag-and-drop for the deckbuilder, exceljs + pdfmake/@react-pdf for export, plus CSS/Tailwind and Vite HMR for the iteration loop that a card-art-heavy UI demands. FTS5 ships enabled in the prebuild, so card search is free. Vitest against `:memory:` with a *synchronous* driver makes the DB layer unusually pleasant to test.

**The one thing you must not do is ship electron-builder's `portable` target as the primary artifact** — it re-extracts ~350 MB to `%TEMP%` on every launch (2–5 s best case, up to ~60 s on AV-scanned/HDD machines). Ship `target: zip`: the user extracts once, the exe launches in ~1 s, and the DB + 1 GB image cache sit visibly next to it. Offer the portable .exe as a secondary labeled build.

**Accepted costs:** ~100 MB download, ~350 MB on disk, 150–300 MB RAM, an 8-week Chromium upgrade treadmill. All are acceptable for a desktop collection tracker; none of them are what makes or breaks this app.

### 🥈 2. Tauri 2.11 + React/TS + rusqlite command layer
Pick this **only if a ~10 MB binary is a hard product requirement**. You get a genuinely single-file portable exe (~8–15 MB), ~60 MB RAM, and an excellent Rust unit-test story. You pay: a Rust+MSVC toolchain with 3–10 min release builds and no cross-compilation; a two-language codebase; a JSON IPC boundary (6.7 ms per 64 KB) you architect around forever; asset-protocol scope config for the image cache; an E2E harness (`tauri-driver` + `msedgedriver`) coupled to Edge's auto-update cadence; and — most damning for the stated requirement — **no in-band answer when WebView2 is missing**, since the only fixes (`offlineInstaller` ~127 MB, `fixedVersion` ~180 MB) are installer-only or a folder-next-to-exe, which lands you worse off than the Electron ZIP. Portable mode is officially unsupported; the raw `target/release/*.exe` works but maintainers say it is "typically not shippable as-is."

### 🥉 3. .NET 10 (LTS) + Avalonia 12
The best **portability** and **testing** stories of the four. Single-file self-contained publish extracts natives **once per version** (not per launch) to a directory you can pin with `DOTNET_BUNDLE_EXTRACT_BASE_DIR`; ~70–90 MB single exe; ~200–500 ms startup; ~60–120 MB RAM. `Avalonia.Headless.XUnit` gives real in-process UI tests that nothing in the web stacks matches. ClosedXML (MIT) is the cleanest Excel export of any option. **It loses on the thing this app mostly is**: a rich, heavily-iterated, image-dense custom UI with fluid drag-drop. No CSS, no component ecosystem, weak HMR, hand-built DnD. Choose it if the developer is primarily a C# developer, or if headless UI testing is a top-3 requirement. Note `.NET 8/9 are both EOL 2026-11-10` — target 10. Note QuestPDF's Community License exclusions.

### 4. Flutter desktop — **not recommended for this app**
No first-party single-file exe (folder + VC++ redist DLLs, with documented missing-DLL failures on target machines). **Impeller is still not shipped on Windows** — Skia+ANGLE's runtime shader compilation jank hits exactly this app's hottest path, a fast-scrolling image grid. Ecosystem is thinnest where it matters: `sqlite3_flutter_libs` is EOL, `excel` and `flutter_staggered_grid_view` and `cached_network_image` are 2+ years stale, `super_drag_and_drop` is pre-1.0, and the only maintained XLSX writer is Syncfusion (licensed). Drift is genuinely good and testing is strong, but that's one column out of five. Only revisit if mobile companion apps become a requirement.

### Not recommended now
- **Wails v3** — beta shipped 2026-08-02, two days ago. Architecturally a great fit (pure-Go `modernc.org/sqlite` → true zero-toolchain single binary). Revisit in 6–12 months.
- **Neutralino 6.4.0** — no native SQLite story, API surface too thin.

---

# 10. SOURCES

Registry/API data queried live 2026-08-04: `registry.npmjs.org`, `api.nuget.org`, `crates.io/api/v1`, `pub.dev/api`, `api.scryfall.com`, GitHub release asset `Content-Length`.

- [Electron release schedule](https://releases.electronjs.org/schedule) · [Electron v43.2.0](https://releases.electronjs.org/release/v43.2.0) · [electron/electron releases](https://github.com/electron/electron/releases)
- [better-sqlite3 releases](https://github.com/WiseLibs/better-sqlite3/releases) · [v13.0.0 notes](https://github.com/WiseLibs/better-sqlite3/releases/tag/v13.0.0) · [threads.md](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/threads.md)
- [electron-builder PortableOptions](https://www.electron.build/electron-builder.Interface.PortableOptions.html) · [electron-builder](https://www.electron.build/) · [issue #5765 portable startup](https://github.com/electron-userland/electron-builder/issues/5765) · [issue #7870 unpackDirName multi-instance](https://github.com/electron-userland/electron-builder/issues/7870) · [issue #3841 PORTABLE_EXECUTABLE_DIR](https://github.com/electron-userland/electron-builder/issues/3841) · [PORTABLE_EXECUTABLE_FILE](https://www.tutorialpedia.org/blog/how-to-get-the-original-path-of-a-portable-electron-app/)
- [electron-vite distribution](https://electron-vite.org/guide/distribution) · [Electron automated testing](https://www.electronjs.org/docs/latest/tutorial/automated-testing) · [Playwright Electron class](https://playwright.dev/docs/api/class-electron) · [Electron issue #43513](https://github.com/electron/electron/issues/43513)
- [Scryfall bulk data](https://scryfall.com/docs/api/bulk-data) · [Scryfall rate limits](https://scryfall.com/docs/api/rate-limits) · [Scryfall card imagery](https://scryfall.com/docs/api/images) · [Scryfall blog: JSONL migration](https://scryfall.com/blog/upcoming-api-changes-to-scryfall-image-uris-and-download-uris-224)
- [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) · [Tauri SQL plugin](https://v2.tauri.app/plugin/sql/) · [Tauri asset protocol scope](https://v2.tauri.app/security/asset-protocol/) · [Tauri WebDriver](https://v2.tauri.app/develop/tests/webdriver/) · [WebdriverIO Tauri platform support](https://webdriver.io/docs/desktop-testing/tauri/platform-support/) · [discussion #3048 standalone binary](https://github.com/tauri-apps/tauri/discussions/3048) · [discussion #9884 exe location](https://github.com/tauri-apps/tauri/discussions/9884) · [discussion #11915 IPC perf](https://github.com/tauri-apps/tauri/discussions/11915) · [issue #7127 raw binary IPC](https://github.com/tauri-apps/tauri/issues/7127)
- [WebView2 Evergreen vs fixed](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/evergreen-vs-fixed-version) · [WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution)
- [.NET single-file deployment](https://learn.microsoft.com/dotnet/core/deploying/single-file/overview) · [.NET publishing overview](https://learn.microsoft.com/dotnet/core/deploying/) · [.NET support policy](https://dotnet.microsoft.com/en-us/platform/support/policy) · [Announcing .NET 10](https://devblogs.microsoft.com/dotnet/announcing-dotnet-10/) · [Unpackaged WinUI 3 single-file](https://learn.microsoft.com/windows/apps/package-and-deploy/unpackage-winui-app#single-file-exe)
- [Avalonia releases](https://github.com/AvaloniaUI/Avalonia/releases) · [Avalonia Native AOT](https://docs.avaloniaui.net/docs/deployment/native-aot) · [Avalonia ItemsRepeater](https://docs.avaloniaui.net/controls/data-display/collections/itemsrepeater) · [Avalonia performance](https://docs.avaloniaui.net/docs/guides/development-guides/improving-performance) · [Avalonia size discussion #14633](https://github.com/AvaloniaUI/Avalonia/discussions/14633)
- [QuestPDF Community License](https://www.questpdf.com/license/community.html) · [ClosedXML](https://github.com/ClosedXML/ClosedXML)
- [Flutter: building Windows apps](https://docs.flutter.dev/platform-integration/windows/building) · [Impeller](https://docs.flutter.dev/perf/impeller) · [Impeller Vulkan desktop design doc #183495](https://github.com/flutter/flutter/issues/183495) · [What's new in Flutter 3.44](https://flutter.dev/blog/whats-new-in-flutter-3-44)
- [Wails releases](https://github.com/wailsapp/wails/releases) · [Wails v3](https://v3.wails.io/) · [Neutralinojs framework notes](https://neutralino.js.org/docs/release-notes/framework/)
- [TypeScript 7.0 GA (InfoQ)](https://www.infoq.com/news/2026/08/typescript-7-released/) · [SheetJS npm migration](https://cdn.sheetjs.com/xlsx/) · [SheetJS leaving npm](https://www.bleepingcomputer.com/news/software/npm-package-with-14m-weekly-downloads-ditches-npmjscom-for-own-cdn/)

## Recommendations

- ADOPT Electron 43.2.0 + electron-vite 5.0.0 + Vite 7.3.6 + React 19.2.8 + better-sqlite3 13.0.2 as the primary stack. Pin Vite to 7.3.6 — electron-vite 5.0.0 peer-caps at Vite 7, and Vite 8 support only exists in electron-vite 6.0.0-beta.1.
- DO NOT ship electron-builder's `portable` target as the primary artifact. It re-extracts ~350 MB to %TEMP% on EVERY launch (2-5s best case, up to ~60s on AV-scanned/HDD machines per electron-builder issue #5765). Ship `target: zip` instead — user extracts once, launches in ~1s. Offer the portable .exe as a clearly-labeled secondary convenience build with `unpackDirName: false` and a `splashImage`.
- Resolve app data via `process.env.PORTABLE_EXECUTABLE_DIR ?? path.dirname(app.getPath('exe'))` + `/data`, with a `fs.accessSync(W_OK)` probe falling back to `app.getPath('appData')` for read-only USB / Program Files installs. Call `app.setPath('userData'|'sessionData'|'logs', ...)` BEFORE `app.whenReady()` — `userData` cannot be changed after ready.
- Set `npmRebuild: false` and `asarUnpack: ['**/node_modules/better-sqlite3/**']`. better-sqlite3 13.0.2 ships `prebuilds/win32-x64.node` (1,989,632 bytes) with NAPI_VERSION=10 directly in the npm tarball — no node-gyp, no @electron/rebuild, no VS Build Tools on dev machines or CI. Keep asarUnpack anyway: .node files cannot be reliably dlopen'd from inside an asar.
- REWRITE the ingest design for JSONL, not JSON. Scryfall retired monolithic JSON arrays on 2026-07-20; bulk objects now expose only `jsonl_download_uri` + `compressed_size`. Pipeline: fetch(jsonl_download_uri) -> zlib.createGunzip() -> readline -> batched prepared inserts in ONE transaction. Target `default_cards` (77.3 MB gz, ~500 MB raw, 105,651 prints). Expect 8-25s end-to-end.
- Run ingest in `utilityProcess.fork()`, NOT `worker_threads`. Electron issue #43513 documents better-sqlite3 failing to resolve inside worker_threads in packaged/asar builds. utilityProcess is a real Node child with full native-module support and a MessagePort back to main. Note SQLITE_THREADSAFE=2 in the prebuild — one connection per process, never share a handle.
- Design the schema as hot-columns + raw JSON: real columns for `id, oracle_id, name, set_code, collector_number, cmc, type_line, rarity, colors, color_identity, released_at, price_usd, image_grid_id` plus a `raw` TEXT column for the other ~50 of the 66 card fields. Add an FTS5 external-content virtual table over `name, type_line, oracle_text` — FTS5, JSON1, STAT4 and math functions are all confirmed enabled in the shipped prebuild. Set `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;` (cache_size is already 16 MB by default).
- Cache the WebP `grid`/`thumb` image variants (~8-12 KB each, ~1.0-1.3 GB for 105,651 cards) for the grid; fetch `normal` (~65 KB, would be ~6.5-7.4 GB) lazily on card detail only. Scryfall added 5 new WebP keys (thumb, grid, display, art, crop) to `image_uris` — use them, they are materially smaller than the JPEG variants.
- Make the image warm a resumable background job, never a blocking first-run step. Scryfall caps sustained traffic at <10 req/s (50-100ms spacing), so a full small-image warm takes ~3 hours. Send a descriptive User-Agent with contact info plus `Accept: application/json` — generic UAs (curl/python-requests defaults) are routinely blocked.
- Serve cached images via a privileged custom scheme, not file://. `protocol.registerSchemesAsPrivileged([{scheme:'mtg', privileges:{standard:true, secure:true, supportFetchAPI:true, stream:true}}])` + `protocol.handle('mtg', ...)`. `stream: true` gives Range support, which matters when a virtualized grid fires hundreds of concurrent image requests.
- Pick @tanstack/react-virtual 3.14.9 or react-virtuoso 4.18.11 (VirtuosoGrid) for the card-art grid, and ag-grid-community 36.0.2 (MIT) for the tabular collection view. Verify you never need ag-grid-enterprise — it is licensed `Commercial`.
- Use @atlaskit/pragmatic-drag-and-drop 2.0.1 for the deckbuilder, not @dnd-kit. @dnd-kit/core 6.3.1 has been static since 2024-12-05, and the v2 rewrite (@dnd-kit/react + @dnd-kit/dom 0.5.0) is still 0.x.
- For export use exceljs 4.4.0 or write-excel-file 4.1.1 (actively maintained, write-only — fine since you only export) plus pdfmake 0.3.11 or @react-pdf/renderer 4.5.1. BAN the npm `xlsx` package: SheetJS left npm, the registry copy is frozen at 0.18.5 with 2 unfixed high-severity advisories (ReDoS, prototype pollution).
- Make a deliberate TypeScript decision and record it. TS 7.0.2 (GA 2026-07-08, Go-native, 8-12x faster) has NO stable programmatic API until 7.1, so typescript-eslint, ts-jest, and ts-morph cannot run on it. Either stay on 6.0.3, or run 7.0.2 for `tsc --noEmit` speed while keeping 6.0.3 for lint tooling.
- Test with Vitest 4.1.10 against `:memory:` — better-sqlite3 is synchronous, so DB fixtures need no async setup/teardown. Add Playwright 1.62.1 `_electron.launch()` for e2e, but build a test-mode IPC channel to inject fake file paths: Playwright cannot intercept `dialog.showOpenDialog`/`showSaveDialog`/`showMessageBox` because those run in main and go straight to OS APIs.
- Pin electron-builder to an exact version. Its `latest` dist-tag (26.15.3, 2026-06-09) lags the `v26` tag (26.15.7, 2026-07-18); a bare `npm i electron-builder` gets the older build. Avoid 27.0.0-alpha.6.
- Fix the .NET version in the design doc if that path is taken: .NET 8 AND .NET 9 both reach EOL on 2026-11-10. Target .NET 10 (LTS, EOL 2028-11-10) with Avalonia 12.1.1, not 8/9.
- If Tauri is chosen despite the ranking, use a rusqlite 0.40.1 command layer, NOT tauri-plugin-sql 2.4.0 — the plugin round-trips every row through JSON IPC twice (measured ~6.7 ms per 64 KB vs ~600 us for raw bytes). Do the full ingest in Rust and page results across IPC. Also budget for: MSVC toolchain, 3-10 min release builds, no cross-compilation, and asset-protocol CSP + scope config for the image cache.
- If Tauri is chosen, resolve the WebView2 gap explicitly before committing. It is preinstalled on all Win11 and pushed to eligible Win10 1803+, but missing on Win10 LTSC, Windows Server, and some managed corporate images — and a raw portable exe has no bootstrapper. The only fixes (`offlineInstaller` +127 MB, `fixedVersion` +180 MB as a folder beside the exe) are installer-only and land you worse off than the Electron ZIP.
- Revisit Wails v3 in 6-12 months. v3.0.0-beta.0 shipped 2026-08-02 (beta.3 on 08-03) — far too fresh to commit to, but Go + `modernc.org/sqlite` (pure Go, no cgo) is architecturally the cleanest path to a true zero-toolchain single-file portable exe for this exact app.
