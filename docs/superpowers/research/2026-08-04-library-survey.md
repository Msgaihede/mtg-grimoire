# Research: library-survey (2026-08-04)

## Summary

All eight areas verified against the live npm registry, GitHub API, upstream source, and — where it mattered — real benchmarks executed on this machine (Node 24.16.0 and a real Electron 43.2.0 install, Windows 11). Three findings overturn what the current blog/search consensus says. (1) The widely-repeated claim that `node:sqlite` lacks FTS5 is stale: nodejs/node#56951 is closed, `SQLITE_ENABLE_FTS5` is in both `deps/sqlite/sqlite.gyp` and `deps/sqlite/unofficial.gni` (the GN file Electron's build actually consumes), and I confirmed FTS5 working inside Electron 43.2.0 (SQLite 3.53.1) by creating an fts5 vtable and running a MATCH query. (2) better-sqlite3 v13.0.0 (2026-07-21) is its first N-API release — I installed it and `require()`d it inside Electron 43 with zero rebuild, no node-gyp, no `@electron/rebuild`, no install script. Its historical drawback is gone. (3) The whole "stream a ~500MB JSON file" premise is obsolete for Scryfall: as of 2026-07-20 Scryfall retired monolithic JSON arrays, and the live `/bulk-data` manifest today returns only `jsonl_download_uri` + `compressed_size` (all_cards 372MB .jsonl.gz, default_cards 74MB). Line-delimited parsing via `node:readline` + `JSON.parse` measured 171 MB/s vs 36 MB/s for @streamparser/json and 22 MB/s for stream-json — 4.7x and 7.8x faster respectively. Elsewhere: dnd-kit's stable line has not published in 20 months while its successor is still 0.5.0, making Atlassian's Apache-2.0 pragmatic-drag-and-drop (2.0.1, pushed 2026-08-04) the only DnD library with a shipped stable major in 2026; react-dnd is dead (npm frozen at 16.0.1 since 2022); npm `xlsx` is frozen at 0.18.5 from 2022 and SheetJS now distributes only from its own CDN; exceljs is MIT and on npm but has not had a stable release since Oct 2023; and shadcn/ui silently switched its CLI default from Radix to Base UI in July 2026, which matters because `@base-ui-components/react` is still 1.0.0-rc.0.

## Details

> Environment used for all measurements: Windows 11 Pro 26200, Node **v24.16.0**, real **Electron 43.2.0** install (Node 24.18.0, Chromium 150.0.7871.129). All version/date data pulled live from `registry.npmjs.org` and `api.github.com` on **2026-08-04**.

---

# 1. Drag-and-drop for the deckbuilder

## WINNER: `@atlaskit/pragmatic-drag-and-drop` **2.0.1**

*The only DnD toolkit with a shipped stable major release in 2026; Apache-2.0; framework-agnostic core with no React peer at all, so React 19.2 is a non-issue.*

| package | npm latest | published | repo pushed | stars / open issues | license |
|---|---|---|---|---|---|
| `@atlaskit/pragmatic-drag-and-drop` | **2.0.1** | 2026-06-17 | 2026-08-04 | 12,717 / 101 | Apache-2.0 |
| `@dnd-kit/core` (v6, "stable") | 6.3.1 | **2024-12-05** | 2026-07-13 | 17,482 / 118 | MIT |
| `@dnd-kit/react` (successor) | **0.5.0** | 2026-06-11 | 2026-07-13 | — | MIT |
| `react-dnd` | 16.0.1 | **2022-04-19** | 2025-07-06 | 21,630 / **474** | MIT |

**dnd-kit is in an awkward split.** The line you'd actually install today, `@dnd-kit/core@6.3.1`, has had **no publish in 20 months**. The docs repo `dnd-kit/docs` was **archived read-only on 2026-02-21**. The successor (`@dnd-kit/react` + `@dnd-kit/dom` + `@dnd-kit/abstract` + `@dnd-kit/state`) is real and moving — changelog shows v0.1.x (Apr–Aug 2025) → v0.2.0 (Dec 2025) → v0.3.x (Feb 2026) → v0.4.0 (Apr 2026) → v0.5.0 (Jun 2026), with a `0.5.1-beta-20260713030121` tag — but **there is no 1.0 and no stability statement anywhere in the changelog or docs site**. Its API is a full rewrite: `<DragDropProvider>` / `useDraggable` / `useDroppable` / `useSortable` (from `@dnd-kit/react/sortable`) / `<DragOverlay>`, exports `['.', './hooks', './sortable', './utilities']`, peer `react: ^18.0.0 || ^19.0.0`. Committing a deckbuilder's core interaction to a 0.x with no stable predecessor being patched is the main risk here.

**Licensing note on pragmatic-dnd:** the GitHub API reports `NOASSERTION`, which is a license-detector artifact. I fetched the actual `LICENSE` file — it is verbatim **Apache License 2.0, "Copyright 2024 Atlassian Pty Ltd"**. npm metadata also says `Apache-2.0`. Apache-2.0 requires attribution + NOTICE propagation but is otherwise permissive; no copyleft, fine for a shipped desktop app.

**React 19 status is now resolved for the packages you need.** Issue #181 is still technically open (last updated 2025-12-05) but the blocker has been cleared for greenfield use:

| companion package | latest | published | react peer |
|---|---|---|---|
| `-hitbox` | 2.0.0 | 2026-06-16 | *(none — vanilla)* |
| `-auto-scroll` | 3.0.0 | 2026-06-16 | *(none — vanilla)* |
| `-react-drop-indicator` | 4.1.1 | 2026-07-17 | **`^18.2.0 \|\| ^19.0.0`** ✅ |
| `-flourish` | 3.0.3 | 2026-07-28 | *(none)* |
| `-live-region` | 2.0.0 | 2026-06-16 | *(none)* |
| `-react-beautiful-dnd-migration` | 3.2.0 | 2026-08-03 | `^18.2.0` ⚠️ |

Only the react-beautiful-dnd migration shim still pins React 18 — irrelevant for a new app. Core bundle is <4.7KB and is what powers Trello / Jira / Confluence boards, which is the closest production analogue to a deckbuilder.

**`react-dnd` is dead.** npm frozen at 16.0.1 since April 2022, 474 open issues, no release in 4 years. Exclude.

---

# 2. Virtualized grid for 100k+ cards with images

## WINNER: `@tanstack/react-virtual` **3.14.9**

*Headless MIT virtualizer, actively released (2026-07-28, repo pushed 2026-08-03) — and a card grid needs total markup control (fixed 5:7 aspect frames, `loading="lazy"` images, hover overlays, foil/rarity treatments) that the opinionated libraries fight you on.*

| package | npm latest | published | repo pushed | stars / open issues | license |
|---|---|---|---|---|---|
| `@tanstack/react-virtual` | **3.14.9** | 2026-07-28 | 2026-08-03 | 7,037 / 108 | MIT |
| `react-window` | **2.3.0** | 2026-07-20 | 2026-07-20 | 17,203 / **1** | MIT |
| `react-virtuoso` | **4.18.11** | 2026-07-17 | 2026-08-03 | 6,440 / 55 | MIT (see below) |

All three are healthy. Differentiators:

**`@tanstack/react-virtual`** has no built-in Grid component — for a card grid you run one row virtualizer over `Math.ceil(total / columnsPerRow)` and render the row's slice, which is ~15 lines and gives you responsive column counts for free. `measureElement` handles dynamic heights if you ever need them. You own every DOM node, which is what you want when the item renderer is a styled card face.

**`react-window` 2.3.0** is a **complete rewrite**, not an upgrade. Breaking changes: components renamed (`SimpleList` ← FixedSizeList, `List` ← DynamicSizeList, `Grid` ← VariableSizeGrid); converted to a render-props API; **`layout="horizontal"` removed entirely**; RTL dropped for lists (kept for Grid); ARIA `role` attributes removed; peer React ≥18; **ResizeObserver required** unless explicit pixel dimensions are passed. The maintainer states v1→v2 "may require substantial code changes, many of which will not be possible to automate with codemods." The `1` open issue is a good sign, but the API is 6 weeks old and every tutorial/StackOverflow answer online is for v1.

**`react-virtuoso` licensing — the real answer, since this is subtle.** The GitHub repo root has **no LICENSE file** (404) and root `package.json` has **no `license` field** — it's a monorepo now. Naive license scanners and SBOM tooling will flag this. I unpacked the published tarball to check: `react-virtuoso@4.18.11` **is MIT** (`package/LICENSE` = "MIT License, Copyright (c) 2020 Petyo Ivanov", `package.json` `"license": "MIT"`). Free-forever MIT components: **`Virtuoso`, `GroupedVirtuoso`, `VirtuosoGrid`, `VirtuosoTable`, `Masonry`**. The **`VirtuosoMessageList`** component is a *separate* commercially-licensed package: **$14/mo/seat ($168/yr)**, Pro **$26/mo/seat ($312/yr)**, 30-day non-production trial. You do not need it for a card grid — but be aware the package family has a commercial arm, and if your license policy auto-rejects "no LICENSE in repo," add an explicit allow entry.

Performance is *not* the deciding factor: at 100k items all three hit 60fps; the bottleneck moves entirely to your item renderer. Choose on API fit.

---

# 3. SQLite in the Electron main process + FTS5

## WINNER: `node:sqlite` (built into Electron 43)

*FTS5 is confirmed present and working in Electron 43; zero native modules means zero asar-unpack config, zero `@electron/rebuild`, zero macOS notarization of a `.node` binary, and zero CI build matrix.*

## The FTS5 question — resolved, contrary to every blog post

Every search result on this topic (and nodejs/node#56951 discussion, openclaw issues #3776/#20987/#59518/#62328) says node:sqlite is compiled without FTS5. **That is stale.** Issue #56951 is **closed**. Verified three independent ways:

**(a) Upstream source.** `deps/sqlite/sqlite.gyp` at `v24.16.0`, `v24.18.0` and `main` all contain `SQLITE_ENABLE_FTS5`. Critically, `deps/sqlite/unofficial.gni` — **the GN file Electron's build actually consumes**, since Electron builds Node via GN, not gyp — carries the same define list. Electron has **59 patches in `patches/node/` and none of them touch sqlite**.

Full define set (both gyp and gni): `SQLITE_ENABLE_COLUMN_METADATA`, `DBSTAT_VTAB`, `FTS3`, `FTS3_PARENTHESIS`, **`FTS5`**, `GEOPOLY`, `MATH_FUNCTIONS`, `PERCENTILE`, `PREUPDATE_HOOK`, `RBU`, `RTREE`, `SESSION`.

**(b) Plain Node 24.16.0.** `pragma_compile_options` returns `... ENABLE_FTS3, ENABLE_FTS3_PARENTHESIS, ENABLE_FTS5, ENABLE_GEOPOLY, ...`; SQLite 3.53.0.

**(c) Real Electron 43.2.0 run.** This is the authoritative check:

```
electron 43.2.0  node 24.18.0  chrome 150.0.7871.129
sqlite_version: 3.53.1
FTS5: AVAILABLE, match rows=[{"name":"Lightning Bolt"}]
```

(`deps/sqlite/sqlite3.h` at v24.18.0 defines `SQLITE_VERSION "3.53.1"` — exact match, confirming Electron uses Node's bundled SQLite unmodified.)

## Stability index

From `doc/api/sqlite.md` at `v24.18.0`: **`Stability: 1.2 - Release candidate`**. Promoted to RC in **v24.15.0** (PR #61262); was un-flagged from `--experimental-sqlite` in v23.4.0/v22.13.0. So Electron 43 ships an RC-grade, not Stable-grade, API. In practice this means "API settled barring significant issues" — and Electron pins the Node version, so you won't be surprised mid-release-line.

## better-sqlite3 v13 — the N-API change removes its only real drawback

`better-sqlite3@13.0.2` (2026-07-29, MIT, SQLite 3.53.4). **v13.0.0 (2026-07-21) is "the first version of better-sqlite3 to run on the N-API."** Verified in the real Electron 43 app:

```
BS3 LOADED IN ELECTRON, no rebuild. sqlite 3.53.4 | bs3 13.0.2
BS3 FTS5: AVAILABLE
```

Package manifest confirms: `scripts.install` is **null** (no node-gyp, `prebuild-install` dependency removed), sole dependency is `node-addon-api@^8`. Ships 8 prebuilds: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `linuxmusl-arm64`, `linuxmusl-x64`, `win32-arm64`, `win32-x64`. v13 also adds `db.explain()` and `preparedStatement.toString()`.

## Head-to-head benchmark (110,000 rows, WAL, `synchronous=OFF`, Windows 11)

| operation | `node:sqlite` | `better-sqlite3` 13.0.2 | winner |
|---|---|---|---|
| INSERT 110k, prepared, single tx | **153 ms** | 213 ms | node:sqlite 1.4x |
| FTS5 external-content `'rebuild'` | 252 ms | 243 ms | tie |
| FTS5 `light*` + join + ORDER BY rank LIMIT 50 | 4.83 ms | 5.00 ms | tie |
| `SELECT id,name,type_line` → `.all()` 110k | 65 ms | **39 ms** | bs3 1.7x |
| `.iterate()` 110k rows | 87 ms | **61 ms** | bs3 1.4x |

better-sqlite3 wins on bulk reads (its row-marshalling is faster), node:sqlite wins on writes. **Neither gap is architecturally significant** for this app, because you should never materialize 110k rows into the renderer — you page and virtualize. The deciding factor is packaging risk, and node:sqlite has none.

## FTS5 schema tuning — measured, 110k MTG-shaped card names

Schema used: `CREATE VIRTUAL TABLE fts USING fts5(name, type_line, oracle_text, content='cards', content_rowid='id', tokenize='unicode61 remove_diacritics 2')` (external-content, so the FTS index doesn't duplicate your row data).

| query | latency | note |
|---|---|---|
| `lig*` (2-char prefix) | **3.03 ms** | as-you-type territory |
| `light*` | **3.01 ms** | |
| `"lightning bolt"` (phrase) | **0.43 ms** | |
| `name:goblin* AND name:guide*` (column filter) | **0.75 ms** | |
| naive `name LIKE '%bolt%'` | **14.92 ms** | 5–35x slower, no index possible |

**`prefix='2 3 4'` is not worth it here.** Measured: `lig*` was 2.93 ms with the prefix index vs 3.03 ms without — inside noise — while the index rebuild went from **260 ms → 904 ms (3.5x)** and inflated the DB. Skip it; plain FTS5 prefix queries are already fast enough for keystroke-latency search.

Sizing: 110k rows + two FTS tables = **57 MB**. 100k rows with the full Scryfall JSON blob retained in a `json` column = **144 MB**.

**End-to-end ingest pipeline** (gzipped JSONL → gunzip → readline → `JSON.parse` → `node:sqlite` prepared INSERT in 50k-row transactions → FTS5 rebuild), 100k cards: **1.4 s ingest + 0.36 s FTS rebuild, peak RSS 131 MB.** Extrapolating linearly to Scryfall's ~110k default_cards, full import is comfortably under 3 seconds.

**Fallback trigger:** switch to better-sqlite3 v13 if you need a SQLite version newer than Electron's, loadable extensions beyond what's compiled in, or the bulk-read throughput. The N-API change makes that switch cheap now — but you'd need `asarUnpack: ["**/*.node"]` in electron-builder and a macOS codesign entry for the binary.

---

# 4. Streaming JSON parse of a ~500MB file

## WINNER: neither — `node:readline` + `JSON.parse` over gzipped JSONL

*Scryfall retired monolithic JSON arrays on 2026-07-20. Everything is line-delimited now, and line-delimited parsing is 4.7–7.8x faster than either streaming JSON parser.*

## The premise changed — live API check, 2026-08-04

`GET https://api.scryfall.com/bulk-data` today returns objects with **only `jsonl_download_uri` and `compressed_size`**. The fields `download_uri`, `size`, `content_type` and `content_encoding` are **gone from the response entirely**:

| type | compressed | uri |
|---|---|---|
| `all_cards` | 390,063,293 B (**372 MB**) | `.../all-cards-20260803214537.jsonl.gz` |
| `default_cards` | 77,332,681 B (**74 MB**) | `.../default-cards-20260803211627.jsonl.gz` |
| `unique_artwork` | 37,275,399 B (36 MB) | `.jsonl.gz` |
| `oracle_cards` | 24,443,680 B (23 MB) | `.jsonl.gz` |
| `art_tags` | 12,395,021 B (12 MB) | `.jsonl.gz` |
| `oracle_tags` | 5,896,524 B (6 MB) | `.jsonl.gz` |
| `rulings` | 5,300,458 B (5 MB) | `.jsonl.gz` |

`default_cards` at 74 MB gzipped decompresses to roughly the "~500MB" figure in the brief — that's the file you're thinking of, and it is now JSONL.

## Benchmark: 85.7 MB / 100,000 Scryfall-shaped card records, Node 24.16.0

| approach | wall time | throughput | peak RSS |
|---|---|---|---|
| **manual chunk split + `JSON.parse`** | **0.45 s** | **189 MB/s** | 117 MB |
| **`node:readline` + `JSON.parse`** | **0.50 s** | **171 MB/s** | **62 MB** |
| `@streamparser/json@0.0.22` core `onValue` | 2.40 s | 36 MB/s | 58 MB |
| `@streamparser/json-node@0.0.22` via `.pipe()` | 2.36 s | 36 MB/s | 58 MB |
| `stream-json@3.5.0` `parser` + `streamArray` | 3.91 s | 22 MB/s | 112 MB |

`readline` is **4.7x faster than @streamparser/json** and **7.8x faster than stream-json**, at the lowest memory of any approach. Manual splitting buys another 10% at 2x the RSS — not worth the correctness risk of hand-rolling the buffer boundary logic. Use `readline` with `crlfDelay: Infinity`.

## If you *do* need a monolithic-JSON parser (e.g. MTGJSON `AllPrintings.json`, which is still one giant object)

**`@streamparser/json` wins**: 1.6x faster and roughly half the peak RSS of stream-json. But two hard gotchas found by running them:

**Bug in `@streamparser/json-node`.** Its `JSONParser` Transform **fails with `ERR_STREAM_PREMATURE_CLOSE` under `stream/promises.pipeline()`**. Identical logic works fine via `.pipe()` + `'data'`/`'end'` listeners at full speed. This is a real defect in a package still at **0.0.22, unchanged since 2025-01-26**. Use `.pipe()`, or use the core `@streamparser/json` package with `parser.onValue` and drive it from `readStream.on('data', c => parser.write(c))`.

**`stream-json@3.5.0` is a breaking rewrite.** It is now **ESM-only** (`"type": "module"`), `engines: {node: ">=22"}`, and the file layout was renamed: `stream-json/streamers/StreamArray` → **`stream-json/streamers/stream-array.js`**, with the API surface moved to `parser.asStream()` / `streamArray.asStream()` (plus new `asWebStream` / `withParser` variants). **Every tutorial and StackOverflow answer online is for v1.x and will throw `MODULE_NOT_FOUND`.** The original author's repo `uNmAnNeR/stream-json` now 404s; ownership moved. License BSD-3-Clause (fine, but note it's not MIT like the rest of the stack).

`@streamparser/json` upstream (`juanjoDiaz/streamparser-json`, 211 stars, MIT) is actively pushed (2026-07-31) despite the frozen version number.

---

# 5. CSV / Excel / PDF

## CSV — WINNER: `papaparse` **5.5.4**

*Battle-tested against exactly the kind of messy, user-supplied exports this app ingests (Moxfield, Deckbox, TCGplayer, ManaBox, Archidekt), and it runs identically in the renderer for import preview.*

| package | latest | published | repo pushed | license |
|---|---|---|---|---|
| `papaparse` | **5.5.4** | 2026-06-19 | 2026-07-03 | MIT |
| `@types/papaparse` | 5.5.2 | 2025-12-13 | (DefinitelyTyped) | MIT |
| `csv-parse` | 7.0.2 | 2026-08-02 | — | MIT |
| `csv-stringify` | 6.8.2 | 2026-08-02 | — | MIT |

What earns it the pick: `header: true` inference, `dynamicTyping`, automatic delimiter detection, and a non-fatal `errors` array that lets you show the user which rows failed instead of aborting the whole import. Ships **no bundled types** — you must add `@types/papaparse` (DefinitelyTyped, so it lags the runtime; verify `ParseConfig` fields against the 5.5.4 docs). 224 open issues but active.

**Alternative if you want stricter Node-native behaviour:** the `node-csv` suite (`csv-parse` + `csv-stringify`, both shipped 2026-08-02) has **bundled TypeScript types**, native Node stream/async-iterator support, and a more rigorous RFC-4180 posture. Better for deterministic round-tripping of *your own* export format; worse at tolerating third-party junk.

## Excel — WINNER: `exceljs` **4.4.0** (with an explicit caveat)

*The only MIT-licensed, actually-on-npm library that does both styled writing and reading of .xlsx in one package.*

| option | latest | published | repo pushed | open issues | license |
|---|---|---|---|---|---|
| `exceljs` | 4.4.0 | **2023-10-19** | 2025-01-21 | **798** | MIT |
| `exceljs` (any tag) | 4.4.1-prerelease.0 | 2024-12-20 | — | — | MIT |
| `xlsx` (SheetJS, npm) | **0.18.5** | **2022-03-24** | — | — | Apache-2.0 |
| `write-excel-file` | 4.1.1 | 2026-06-08 | — | — | MIT |
| `read-excel-file` | 9.3.5 | 2026-07-28 | — | — | MIT |
| `@e965/xlsx` (unofficial mirror) | 0.20.3 | 2024-07-19 | — | — | Apache-2.0 |

**The caveat, stated plainly:** exceljs has had **no stable release since October 2023** and the repo has not been pushed since **January 2025**. There is an open community thread (`exceljs/exceljs` discussion #2987, "Fixing Critical Bugs & Looking for Maintainers") and the maintainer has said they're on leave. It still wins because .xlsx is a *frozen file format* — "stalled" carries far less risk here than it would for a UI library — and because the alternative is either a supply-chain problem (below) or splitting into two packages.

**Actively-maintained fallback pair:** `write-excel-file@4.1.1` + `read-excel-file@9.3.5`, both MIT, both shipped in the last two months. Two dependencies instead of one, no formulas/images/streaming — but for "export my collection to a styled sheet, import a sheet of rows," that's all you need. Switch to this pair if you hit an exceljs bug.

### SheetJS CE — do not use, and here's precisely why

The **license is fine** (Apache-2.0, genuinely open source, permissive). **The distribution is the problem:**

- The npm package `xlsx` is **frozen at 0.18.5, published 2022-03-24** — over four years stale. Versions 0.19.x and 0.20.x were **never published to npm**.
- From 0.18.6 onward SheetJS distributes **only from `https://cdn.sheetjs.com/`**, citing npm's 2FA requirements, "GitHub's abrupt decision-making," and unspecified "legal matters" with npm. The GitHub mirror is also frozen; the canonical repo moved to `git.sheetjs.com`.
- Practical consequences for a shipped desktop app: your `package.json` must point at a tarball URL on a non-npm host; your lockfile has a non-registry integrity entry; **`npm audit`, Dependabot, Renovate, and any SBOM/SCA tooling silently stop tracking it**; corporate registry proxies and airgapped CI break; and there's no npm provenance attestation.
- If you ignore the above and install npm `xlsx@0.18.5` anyway, you inherit **known unpatched CVEs** (prototype pollution and ReDoS fixed only in ≥0.19.3, which is not on npm).
- Third-party mirrors like `@e965/xlsx@0.20.3` are unofficial, unaffiliated, and themselves stale (2024-07-19). Don't launder your supply chain through a stranger's republish.

## PDF deck sheets — WINNER: Electron `webContents.printToPDF()`

*Zero dependencies, and it renders the exact React deck-sheet component and Tailwind theme you already built — every other option makes you re-author the design in a second layout language.*

| option | latest | published | repo pushed | stars / issues | verdict |
|---|---|---|---|---|---|
| **`printToPDF`** | Electron 43.2.0 | 2026-07-21 | — | — | ✅ winner |
| `pdfmake` | 0.3.11 | 2026-06-12 | 2026-06-12 | 12,326 / 232 | good runner-up |
| `@react-pdf/renderer` | 4.5.1 | 2026-04-15 | 2026-07-10 | 16,724 / **427** | viable |
| `pdf-lib` | **1.17.1** | **2021-11-06** | **2024-07-17** | 8,560 / 317 | ❌ exclude |

**Why printToPDF wins for *good-looking* deck sheets specifically.** You're rendering into Chromium 150, so you get, for free and pixel-identical to the on-screen deck view: web fonts (Beleren, mana-symbol icon fonts), OKLCH colors and gradients, CSS Grid/flex layout, `@page { size; margin }`, `break-inside: avoid` for keeping a card block off a page seam, `print-color-adjust: exact` so your dark theme actually prints, and full SVG/`<img>` support for card art and mana pips. Options map to Chromium's own print settings: `{ landscape, pageSize, margins, printBackground, scale, headerTemplate, footerTemplate, generateDocumentOutline }`. Practical pattern: render the sheet into an offscreen `BrowserWindow` (`show: false`), wait for `document.fonts.ready` and image decode, then `printToPDF`. Cost: ~500ms–2s per document, entirely acceptable for an on-demand export.

**`pdfmake` 0.3.11** is the pick *only* if you need PDF generation outside a window — pure-Node, headless, or a CLI. Declarative JSON document definition, good tables/headers/footers/page-breaks, MIT (`LICENSE`: bpampuch 2014–2015, liborm85 2016–2026), actively released. Cost: custom fonts require building a vfs_fonts bundle, and you author the layout twice.

**`@react-pdf/renderer` 4.5.1** gives you JSX, but it is a *separate* Yoga/flexbox renderer — it does **not** consume your Tailwind classes or app CSS, so you rewrite all styling in its `StyleSheet` subset. 427 open issues, including a long-standing custom-font hang (`usePDF` stuck `loading`, issue #2675).

**`pdf-lib` is out on two counts:** last publish **2021-11-06**, repo untouched since 2024-07-17 — and more fundamentally it's a PDF *manipulation* library with **no layout engine** (no text wrapping, no tables, no flow). Wrong tool. Keep it in mind only if you later need to *merge* or *stamp* existing PDFs.

---

# 6. Typed IPC + renderer state

## IPC — WINNER: plain `contextBridge` + a typed channel map

*~40 lines, zero dependencies, full end-to-end inference from one shared interface — and every tRPC-for-Electron package is a low-bus-factor project pinned to an old tRPC major.*

| option | latest | published | repo pushed | stars | license |
|---|---|---|---|---|---|
| `electron-trpc` | 0.7.1 | **2024-12-07** | 2025-07-28 | **401** | MIT |
| `trpc-electron` (fork, tRPC 11) | 0.1.2 | 2025-01-06 | — | — | MIT |
| `electron-trpc-experimental` (fork) | — | — | — | — | MIT |
| `@egoist/tipc` | 0.4.0 | 2026-07-17 | — | — | ISC |
| `@electron-toolkit/preload` | 3.0.2 | 2025-04-19 | — | — | MIT |

`electron-trpc` is **pinned to tRPC v10** and hasn't published since Dec 2024. The community response was to fork twice (`trpc-electron` by mat-sz for tRPC 11; `electron-trpc-experimental` by makp0 with async-generator streaming). Both are single-maintainer, sub-1.0, and low-download. For a shipped desktop app you'd be taking a hard dependency on an unmaintained bridge to get types you can produce yourself.

The DIY pattern that wins:

```ts
// shared/ipc.ts — single source of truth
export interface IpcApi {
  'cards:search':  (q: SearchQuery) => Promise<CardRow[]>;
  'cards:byId':    (id: string) => Promise<CardRow | null>;
  'deck:save':     (deck: Deck) => Promise<{ id: string }>;
  'bulk:import':   (type: BulkType) => Promise<ImportResult>;
}
type Chan = keyof IpcApi;

// preload.ts
contextBridge.exposeInMainWorld('api', {
  invoke: <C extends Chan>(c: C, ...a: Parameters<IpcApi[C]>) =>
    ipcRenderer.invoke(c, ...a) as ReturnType<IpcApi[C]>,
});

// main.ts — handle() is now type-checked against the same map
function handle<C extends Chan>(c: C, fn: IpcApi[C]) { ipcMain.handle(c, (_e, ...a) => (fn as any)(...a)); }
```

Both approaches use structured clone over the same `ipcRenderer.invoke` channel; tRPC adds a router + serialization + optional validation layer per call, which is measurable when a query returns thousands of rows. Note also there's a long-open Electron feature request for first-party typed IPC (electron#33691) — nothing shipped.

If you want a helper rather than hand-rolling, **`@egoist/tipc@0.4.0`** (2026-07-17, ISC) is the lightest actively-maintained option.

## Renderer state — WINNER: `@tanstack/react-query` **5.101.4** for DB reads, with `zustand` **5.0.14** alongside for UI state

*These are not competitors — they sit on orthogonal axes. React Query owns "data that lives in the main-process DB"; zustand owns "data that lives only in this window."*

| package | latest | published | license |
|---|---|---|---|
| `@tanstack/react-query` | **5.101.4** | 2026-07-21 | MIT |
| `zustand` | **5.0.14** | 2026-05-28 | MIT |
| `jotai` | 2.20.2 | 2026-07-14 | MIT (`3.0.0-alpha.0` exists) |

React Query is **transport-agnostic — nothing about it requires HTTP.** Your `queryFn` is literally `() => window.api.invoke('cards:search', q)`. What that buys you, all of which you'd otherwise hand-roll over IPC: request dedup (three components asking for the same card = one IPC round-trip), `staleTime` caching so re-opening a deck doesn't re-query, `placeholderData: keepPreviousData` for flicker-free pagination, `useInfiniteQuery` feeding the virtualizer directly, `invalidateQueries` after a mutation, and automatic cancellation on unmount.

`zustand` for genuinely local state: current deck draft, filter/sort UI, multi-select, panel layout, drag state. Small, unopinionated, no provider, works fine outside React (handy for preload-adjacent helpers).

`jotai` is excellent but its atom-graph model is a *second* mental model layered on top of React Query's cache, and the payoff (fine-grained subscriptions) is small in a desktop app where the expensive boundary is IPC, not re-renders. Also note `3.0.0-alpha.0` is in flight — a major is coming.

---

# 7. Styling / UI kit for a dark card-game aesthetic

## WINNER: Tailwind CSS v4 (**4.3.3**) + shadcn/ui with `--base radix`

*A bespoke card-game look means unstyled primitives plus your own design tokens; every batteries-included kit makes you fight its defaults. shadcn copies source into your repo, so there is nothing to fight.*

| package | latest | published | license | note |
|---|---|---|---|---|
| `tailwindcss` | **4.3.3** | 2026-07-16 | MIT | `v3-lts` tag = 3.4.19 |
| `radix-ui` (unified) | **1.6.7** | 2026-07-24 | MIT | |
| `@radix-ui/react-dialog` | 1.1.23 | 2026-07-24 | MIT | |
| `@base-ui-components/react` | **1.0.0-rc.0** | **2025-12-04** | MIT | ⚠️ still RC |
| `@mantine/core` | 9.5.1 | 2026-08-02 | MIT | |
| `@heroui/react` | 3.2.3 | 2026-07-31 | MIT | |

### Two non-obvious things you must know

**1. shadcn's CLI default flipped from Radix to Base UI in July 2026.** `npx shadcn init` now scaffolds **Base UI**-backed components. Radix is *not* deprecated — every component and block ships in both variants — but the flag matters: **pass `-b radix` (or `--base radix`)**, especially in non-interactive CI. `npx shadcn@latest info` reports which base a project is on via the `base` field in `components.json`. **Recommendation: choose Radix**, because `@base-ui-components/react` is still **`1.0.0-rc.0` from 2025-12-04** — an RC that hasn't cut a stable in eight months — while Radix is at 1.6.7 shipped last week and is the more battle-tested primitive set. Revisit when Base UI cuts 1.0.

**2. Tailwind v4 architecture affects Electron packaging.** v4 **dropped PostCSS** for the Rust-based Oxide engine + Lightning CSS, consumed via the **`@tailwindcss/vite`** plugin (this is what shadcn's Vite install guide uses: `pnpm add tailwindcss @tailwindcss/vite`). `@tailwindcss/oxide` and `lightningcss` install **platform-native `.node` binaries as optionalDependencies**. Two implications: (a) these are **build-time only** — Vite compiles your CSS before packaging, so they belong in `devDependencies` and must **not** be bundled into the shipped app; (b) there's known install flakiness where the postinstall reports success but the native binary is missing (tailwindlabs discussion #18427, plus #15999/#17046) — **pin exact versions, never install with `--no-optional`, and don't share a `node_modules` across OSes** (relevant if you build in WSL and run on Windows).

Other v4 wins for this use case: CSS-first `@theme` config, **OKLCH** color space by default (much better perceptual control for the deep-black/gold/foil palette a card-game UI wants), and `@theme inline`. shadcn components now carry `data-slot` attributes on every primitive for targeted styling, and colors were migrated HSL→OKLCH.

### Why not the others

**Mantine 9.5.1** is the most actively maintained of the three (published 2026-08-02) and technically excellent — new `@mantine/schedule` package, `SimpleGrid` `minColWidth` auto-fill, Standard Schema support in `@mantine/form` (Zod v4 / Valibot / ArkType), Grid moved to native CSS `gap`. Two reasons it loses: it **requires React ≥19.2** (fine today — React is 19.2.8 — but it's a hard floor), and more importantly it's an *opinionated* component library with its own CSS-modules theming layer. Getting from "Mantine default" to "MTG card-game dark" means overriding its styles everywhere, which is more work than styling unstyled primitives from scratch.

**HeroUI 3.2.3** is the newest and least battle-tested. **v3 (March 2026) is a ground-up rewrite** on React Aria Components + Tailwind v4 — 75+ web components (21 new) plus a from-scratch React Native library. Genuinely nice engineering: all animations moved to pure CSS with zero JS runtime, compound-component API, provider wrapper dropped, OKLCH + BEM modifiers, React 19 native. But it is **explicitly not backward compatible with v2**, the API is five months old, and "beautiful by default" is precisely the wrong property when you want a distinctive bespoke aesthetic.

---

# 8. Testing

## WINNER: Vitest **4.1.10** + @testing-library/react **16.3.2** for units; Playwright **1.62.1** `_electron` for e2e

| package | latest | published | license | other tags |
|---|---|---|---|---|
| `vitest` | **4.1.10** | 2026-07-06 | MIT | `V3`=3.2.7, `beta`=5.0.0-beta.7 |
| `@testing-library/react` | **16.3.2** | 2026-01-19 | MIT | — |
| `@playwright/test` | **1.62.1** | 2026-07-30 | Apache-2.0 | `next`=1.63.0-alpha-2026-08-03 |

**Units.** RTL is runner-agnostic — the API is byte-identical under Vitest and Jest, so there's no compatibility story to worry about. `environment: 'jsdom'`, `globals: true`. Vitest 4 is the right default for a Vite/electron-vite project since it shares the same transform pipeline (no separate Babel/ts-jest config, and your `vite.config.ts` aliases just work). Note **`vitest@5.0.0-beta.7`** exists — stay on 4.x. For main-process code (SQLite queries, JSONL import, CSV mapping) use the default `node` environment and test against a real `:memory:` `node:sqlite` DB; it's fast enough (110k-row inserts in 153ms) that you don't need mocks.

**E2E — Playwright's Electron driver status, precisely.** Still **labeled "experimental"** in the docs as of 1.62. In practice: it works via Chrome DevTools Protocol, **VS Code ships on it**, there have been **no breaking changes historically**, and support is stated to continue. "Experimental" here means "no API stability guarantee," not "unreliable." It is also the only credible option — Spectron is long dead.

- **Supported Electron versions:** v12.2.0+, v13.4.0+, v14+ — Electron 43 is well inside.
- **API:** `_electron.launch({ args: ['.'] })` → `electronApp.firstWindow()` (a normal `Page`, so the whole standard Playwright API applies to the renderer) → `electronApp.evaluate(({ app, dialog }) => …)` which runs **in the main process** → `electronApp.close()`.
- **Caveat 1 — the launch-timeout trap:** if you disable the **`nodeCliInspect` fuse** (`FuseV1Options.EnableNodeCliInspectArguments: false`), which hardening guides and `@electron/fuses` templates commonly recommend for production, **Electron launch will hang and time out**. Keep the fuse enabled in your test build, or maintain a separate fuse config for e2e.
- **Caveat 2 — native dialogs are uninterceptable:** they live in the main process and talk directly to OS APIs. Stub them via `electronApp.evaluate()` — e.g. override `dialog.showOpenDialog` to return a fixed path — which is exactly what you'll need for the CSV/Excel/bulk-import flows.
- **Caveat 3 — JS/TS only.** No Electron bindings in playwright-java/python/.NET (playwright-java#1445). Not a constraint here.
- The renderer-side portion of the API is stable, not experimental — only the `_electron` launch surface carries the label.

---

# Appendix: current versions of the surrounding stack (all verified 2026-08-04)

| package | latest | published |
|---|---|---|
| `electron` | **43.2.0** | 2026-07-21 (Node 24.18.0, Chromium 150.0.7871.129) |
| `react` | **19.2.8** | 2026-07-21 |
| `typescript` | **7.0.2** | 2026-07-08 |
| `vite` | **8.2.0** | 2026-07-30 |
| `electron-vite` | 5.0.0 | 2025-12-07 |
| `electron-builder` | 26.15.3 | 2026-06-09 |
| `@electron-forge/cli` | 7.11.2 | 2026-05-20 |
| `electron-updater` | 6.8.9 | 2026-06-05 |
| `drizzle-orm` | 0.45.2 | 2026-03-27 |
| `kysely` | 0.29.4 | 2026-07-17 |

Electron majors 41, 42 and 43 all ship the **same Node 24.18.0**; only Chromium differs (146 / 148 / 150). Note `electron@44.0.0-alpha.9` published 2026-08-03.

**Licensing summary across all winners:** MIT throughout, except `@atlaskit/pragmatic-drag-and-drop` (**Apache-2.0** — attribution + NOTICE propagation required, no copyleft) and `@playwright/test` (Apache-2.0, dev-only). `stream-json` would be BSD-3-Clause if used. **Two traps flagged:** SheetJS `xlsx` (Apache-2.0 license is fine, but off-npm distribution breaks audit/SBOM tooling and the npm copy is 4 years stale with unpatched CVEs), and `react-virtuoso` (npm package is MIT, but the repo has no root LICENSE file so scanners flag it, and the sibling `VirtuosoMessageList` is commercial at $168–$312/seat/yr).

## Recommendations

- DnD: use @atlaskit/pragmatic-drag-and-drop@2.0.1 (Apache-2.0) with @atlaskit/pragmatic-drag-and-drop-hitbox@2.0.0, -auto-scroll@3.0.0 and -react-drop-indicator@4.1.1. Do NOT adopt @dnd-kit/core@6.3.1 (no publish since 2024-12-05, docs repo archived 2026-02-21) and do not bet the deckbuilder on @dnd-kit/react@0.5.0 (still 0.x, no 1.0 on the changelog). Add the Apache-2.0 NOTICE to your about/licenses screen. Skip -react-beautiful-dnd-migration (still pinned to react ^18.2.0).
- Virtualization: use @tanstack/react-virtual@3.14.9. For the card grid, run one row virtualizer over Math.ceil(total / columnsPerRow) and render each row's slice — this gives responsive column counts and total control over the card markup (5:7 aspect frames, loading="lazy" images, hover overlays). If you evaluate react-virtuoso instead, add an explicit license-scanner allow entry (repo root has no LICENSE file — the npm package is MIT) and never pull in VirtuosoMessageList, which is commercial at $168–$312/seat/yr.
- SQLite: use the built-in node:sqlite in the Electron main process. Verified working in a real Electron 43.2.0 run: SQLite 3.53.1 with FTS5 available (SQLITE_ENABLE_FTS5 is in Node's deps/sqlite/unofficial.gni, the GN file Electron's build consumes, and Electron carries no sqlite patches). This eliminates asarUnpack config, @electron/rebuild, macOS codesigning of a .node binary, and a native-build CI matrix. Treat better-sqlite3@13.0.2 as the documented fallback — its v13 N-API rewrite means it now loads in Electron with zero rebuild (verified) and is 1.4–1.7x faster on bulk reads. Note node:sqlite is Stability 1.2 (Release Candidate) since Node v24.15.0, not Stable.
- FTS5 schema: CREATE VIRTUAL TABLE cards_fts USING fts5(name, type_line, oracle_text, content='cards', content_rowid='id', tokenize='unicode61 remove_diacritics 2'). Use external-content so the index does not duplicate row data. Do NOT add prefix='2 3 4' — measured at 110k rows it gave no query benefit (2.93ms vs 3.03ms) while making the index rebuild 3.5x slower (904ms vs 260ms). Measured latencies: 2-char prefix 3.0ms, phrase 0.43ms, column-filtered 0.75ms, vs 14.9ms for naive LIKE '%x%'. remove_diacritics 2 is essential for non-English card names.
- Bulk import: drop the streaming-JSON-parser plan entirely. Scryfall retired monolithic JSON arrays on 2026-07-20 — the live /bulk-data manifest now returns only jsonl_download_uri and compressed_size (all_cards 372MB .jsonl.gz, default_cards 74MB). Pipe fs.createReadStream → zlib.createGunzip() → readline.createInterface({crlfDelay: Infinity}) → JSON.parse per line. Measured 171 MB/s at 62MB peak RSS, which is 4.7x faster than @streamparser/json and 7.8x faster than stream-json. Full 100k-card ingest into node:sqlite with FTS5 measured at 1.4s + 0.36s rebuild.
- Only if you must parse a monolithic JSON blob (e.g. MTGJSON AllPrintings.json), use @streamparser/json@0.0.22 over stream-json (1.6x faster, half the RSS) — but drive it with .pipe() or the core parser's onValue, NOT stream/promises.pipeline(), which fails with ERR_STREAM_PREMATURE_CLOSE. Be aware stream-json@3.5.0 is now ESM-only with renamed paths (streamers/stream-array.js, parser.asStream()), so every tutorial online is wrong.
- CSV: papaparse@5.5.4 plus @types/papaparse@5.5.2 (types are DefinitelyTyped and lag the runtime — verify ParseConfig fields). Use header:true, dynamicTyping, auto delimiter detection, and surface the non-fatal errors array as per-row import warnings rather than aborting. Consider csv-parse@7.0.2 + csv-stringify@6.8.2 (bundled types, node-native, shipped 2026-08-02) for round-tripping your own export format.
- Excel: exceljs@4.4.0 for both import and export, accepting that it is stalled (no stable release since 2023-10-19, repo unpushed since 2025-01-21, 798 open issues) — .xlsx is a frozen format so the risk is bounded. Keep write-excel-file@4.1.1 + read-excel-file@9.3.5 (both MIT, both shipped in the last two months) as the drop-in fallback if you hit a bug. Explicitly ban npm `xlsx` in your dependency policy: it is frozen at 0.18.5 from 2022 with unpatched prototype-pollution/ReDoS CVEs, and SheetJS's CDN-only distribution breaks npm audit, Dependabot, Renovate and SBOM tooling.
- PDF deck sheets: use Electron webContents.printToPDF() against an offscreen BrowserWindow (show:false) rendering the same React component and Tailwind theme as the on-screen deck view. Await document.fonts.ready and image decode before capturing. Use @page for size/margins, break-inside:avoid on card blocks, printBackground:true and print-color-adjust:exact so the dark theme survives. Keep pdfmake@0.3.11 in reserve only if you later need headless/CLI generation. Exclude pdf-lib entirely — last published 2021-11-06 and it has no layout engine (no text wrapping or tables).
- IPC: hand-roll contextBridge + a shared typed channel map (a single `interface IpcApi` keyed by channel name, with a generic invoke wrapper in preload and a generic handle wrapper in main). Avoid electron-trpc@0.7.1 — unpublished since 2024-12-07 and pinned to tRPC v10 — and its single-maintainer forks trpc-electron/electron-trpc-experimental. If you want a helper rather than 40 lines of your own, @egoist/tipc@0.4.0 (ISC, 2026-07-17) is the maintained option.
- State: @tanstack/react-query@5.101.4 for everything that reads the main-process DB (queryFn is just window.api.invoke(...) — React Query is transport-agnostic and needs no HTTP), giving you dedup, staleTime caching, placeholderData:keepPreviousData for flicker-free paging, useInfiniteQuery feeding the virtualizer, and invalidateQueries after mutations. Pair it with zustand@5.0.14 for window-local UI state (deck draft, filters, selection, panel layout). Skip jotai — it adds a second mental model on top of the RQ cache for little gain, and jotai 3.0.0-alpha.0 signals a major in flight.
- Styling: Tailwind CSS v4.3.3 via @tailwindcss/vite, plus shadcn/ui initialized with `npx shadcn init -b radix`. The -b radix flag is mandatory now — shadcn flipped its CLI default to Base UI in July 2026, and @base-ui-components/react is still 1.0.0-rc.0 from 2025-12-04 while radix-ui is at 1.6.7. Use v4's CSS-first @theme with OKLCH tokens for the deep-black/gold/foil palette, and target the new data-slot attributes for per-primitive overrides. Verify the choice later with `npx shadcn@latest info` (the `base` field in components.json is authoritative).
- Tailwind v4 packaging hygiene for Electron: keep tailwindcss, @tailwindcss/vite, @tailwindcss/oxide and lightningcss in devDependencies only — CSS is compiled by Vite before packaging, so the native .node binaries must never ship in the app bundle. Pin exact versions, never install with --no-optional, and do not share a node_modules across OSes (WSL build + Windows run), given the documented optional-dependency install failures in tailwindlabs discussions #18427/#15999/#17046.
- Testing: Vitest 4.1.10 (stay off the 5.0.0-beta) with @testing-library/react 16.3.2 and environment:'jsdom' for components; use the default node environment for main-process code and test against a real :memory: node:sqlite database rather than mocks — 110k-row inserts run in 153ms, so real DB tests stay fast. Add @playwright/test 1.62.1 with _electron.launch for e2e.
- Playwright Electron setup specifics: keep the nodeCliInspect fuse (FuseV1Options.EnableNodeCliInspectArguments) ENABLED in the test build or launch will hang and time out — maintain a separate fuse config for e2e if you harden production. Native OS dialogs cannot be intercepted, so stub dialog.showOpenDialog via electronApp.evaluate() for the CSV/Excel/bulk-import flows. The 'experimental' label means no API stability guarantee, not unreliability — VS Code ships on it and there have been no historical breaking changes.
