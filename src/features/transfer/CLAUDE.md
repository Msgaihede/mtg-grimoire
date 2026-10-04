# src/features/transfer — card import and export

Covers `import/` and `export/`: decklist parsing, destination planning, format writing, and import/export UI dialogs and sheets. Serves desktop decks, collection, wishlist, and the mobile/web light app (see [import-export.md](../../../docs/reference/import-export.md), [frontend-architecture.md](../../../docs/reference/frontend-architecture.md), [decks-storage.md](../../../docs/reference/decks-storage.md), and [text-mirror.md](../../../docs/reference/text-mirror.md)).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../../docs/agent/WORKFLOW.md)
- [Code Style](../../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../../docs/agent/RUNNING_AND_VERIFYING.md)

---

## 1. File I/O Seams (`files.ts`)

Pure TypeScript logic processes strings. Operating system I/O and file pickers are handled strictly by the host backend; **no absolute filesystem paths ever leak to the webview**.

- **File picking (`chooseDecklist`)**: Calls `import_pick_file`. Opens the native dialog in Rust and returns `{ text, encoding }` (or `null` on cancel).
  - Enforces a 1 MB file size cap (`MAX_IMPORT_BYTES`), shared with clipboard paste.
  - Non-lossy encoding fallback: Handles UTF-8 BOM, UTF-16 LE/BE, standard UTF-8, and Windows-1252 (with `LEGACY_ENCODING_NOTICE` displayed).
- **File saving (`saveExport`)**: Calls `export_save_file` with suggested filename and text content; Rust prompts the native save dialog and writes the file.
- **Store-free multi-face design**: Mobile and light web faces reuse transfer logic without accessing desktop app stores:
  - Settings and preferences live in store-free `prefs.ts`.
  - Export state machine in `export/useExportModel.ts`.
  - Import source management in `import/useImportSource.ts`.
  - Preview bodies (`CollectionPreviewBody`, `DeckPreviewBody`, `NewDeckPreviewBody`) accept props directly.
  - Mobile file operations route through browser file utilities (`@/lib/core/files`).

---

## 2. Import Architecture (`import/`)

Importing maps raw text or CSV to database entries across two UI steps: text entry and destination preview.

- **Per-line parser (`parse.ts`)**: Tolerates diverse site exports line by line without premature format lock-in:
  - Line decorations: Strips/extracts finish markers (`*F*`, `*E*`), set hints `(SET)`, brackets `[Category]`, and Archidekt labels `^Label,#color^`.
  - Comment safety: `//` is only treated as a comment at column 0 (double-faced cards contain `//` in card names).
  - Line endings: Accepts CRLF, lone LF, and lone CR.
  - Non-dropping rule: Unparseable lines generate `ParseIssue` objects and are presented to the user; lines are never silently omitted.
- **Heading lookahead (`namesASection`)**: The only lookahead in the parser. Distinguishes category headings from card names by requiring candidate lines to have no quantity, set hint, or brackets, followed by a counted line.
- **Label parsing**: Caret groups (`^Label,#color^`) split colors at the last comma. Labels are deduplicated by `labelNameKey`, matched against existing user labels, and presented in the preview step.
- **CSV format detection (`csv.ts`)**: File-level judgement made on the header row (requires ≥2 recognized headers including Name, plus matching column counts). Delimiter auto-detected (`,`, `;`, `\t`). Escaped formulas unescaped; physical line indices tracked for multiline cells.
- **Category and section resolution**:
  - Precedence order: `forcedCategoryName > SECTION_CATEGORY[kind] > line.categoryName > autoCategoryFor(...)`.
  - Command zone always outranks pile categorization.
  - Right-clicking a pile heading imports directly into that category via `forcedCategoryName`.
- **Destination planner (`destinations/deck.ts`)**: Pure TypeScript planner without React or IPC dependencies. Resolves Oracle tag slugs in a single batch query (`oracleTagsForPrintings`) during the `resolve` mutation to prevent preview flicker.
- **Single-transaction commits**: Imports never run per-line mutations. `deck_import_commit` commits the entire list in one database transaction.
- **Replace mode and virtual decks**: Replacing a live deck list releases owned copies to `Recently removed`. Virtual decks have no physical collection links and never release cardboard or prompt to add cards to collection.

---

## 3. Export Architecture (`export/`)

Exporting transforms card lists into canonical formats via `format.ts`: `(cards, format, fields) => string`.

- **Seven canonical formats**: `plain`, `mtgo`, `arena`, `moxfield`, `archidekt`, `tcgplayer`, and `csv`.
  - Canonical output: Uses LF and trailing newlines. An empty card list outputs an empty string `""`.
  - `tcgplayer`: Mass-entry cart format (flat list, exact printing `[SET] NUM`, no finish markers, retains inactive categories).
  - `archidekt`: Writes `{noDeck}` flags for inactive categories and sanitizes delimiters in pile names (replaces commas and brackets).
  - `arena` / `mtgo`: Omit inactive categories (maybeboards are invalid imports in Arena).
- **Two row filters**:
  - `Only cards MTG Arena has`: Filters by Scryfall Arena legality keys (excluding `gladiator`).
  - `Include inactive categories`: Checkbox under format options (defaults to off).
  - Both filters execute in the UI layer before invoking `formatExport`.
- **Row folding & zone safety**: `foldForFields` merges rows that share chosen field values, but respects `DISCRIMINATOR` maps to prevent cards folding across deck zones (e.g. merging Sideboard into Main).
- **Field selection (`fields.ts`)**:
  - Intersects format capabilities (`FORMAT_FIELDS`) with surface properties (`SURFACE_FIELDS`).
  - `quantity` and `name` are mandatory. Changing format re-initializes defaults.
  - CSV formula escaping: Cells starting with `=`, `+`, `-`, `@`, `\t`, or `\r` are prefixed with an apostrophe.
- **Collection & wishlist sweeping (`export/scope.ts`)**: Automatically pages through virtualized lists in 500-row increments before launching export dialogs.
- **Preview disclosure**: `ExportDialog` opens with the `<pre>` text preview collapsed by default (showing line count in the toggle) to prioritize Copy and Save actions.

---

## 4. The Golden Fence & Dual Writer

A parallel Rust export writer exists in `src-tauri/src/transfer/` to maintain the background plain-text file mirror without webview rendering overhead.

- **Golden test corpus**:
  - `__golden__/corpus.json`: Benchmark dataset covering edge cases (split names, quotes, inactive piles, labels).
  - `__golden__/*.txt`: Golden output files across 7 formats and 2 field configurations.
  - `__golden__/fields.json`: Field registry definitions ensuring parity between TS and Rust field maps.
- **Regeneration**: `npm run golden` regenerates golden files from the TypeScript implementation.
- **Strict parity**: Both Vitest (`golden.test.ts`) and Cargo (`transfer/write.rs`) execute assertions against the same golden files. A discrepancy between TypeScript and Rust fails CI.
- **No Rust parser**: The filesystem mirror only writes files. Transitive round-trip verification is maintained by Vitest parsing the golden files with `parse.ts`.
- **Mirror filter policy**: Row filters (`arenaOnly`, `includeInactive`) remain strictly in the UI. The filesystem mirror includes all cards and piles unconditionally (a backup that narrows itself is not a backup).

---

## 5. Verification Commands

Run verification only at the end of feature work:

| Command | Action |
| --- | --- |
| `npm run test` / `npx vitest src/features/transfer` | Run transfer parser, planner, and export unit tests |
| `cargo test -p mtg-grimoire transfer::` | Run Rust mirror writer parity tests |
| `npm run golden` | Regenerate golden files after deliberate writer or field changes |

Commit discipline:
- One commit per feature matching feature size, bundling implementation, tests, and goldens together for clean `release-please` tracking.

