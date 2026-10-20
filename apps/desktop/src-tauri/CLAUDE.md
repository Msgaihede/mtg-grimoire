# src-tauri — the desktop Rust host

Desktop Tauri 2 application host for mtg-grimoire. Responsible for native windowing, SQLite database hosting, desktop IPC command wrappers, the `mtgimg://` image protocol, background filesystem mirroring, and device sync networking.

Core domain logic, database engines, and cross-platform abstractions reside in [`crates/grimoire-core`](../../../crates/grimoire-core/CLAUDE.md) (and [grimoire-core.md](../../../docs/reference/grimoire-core.md)).

For global repo workflow, style, and testing conventions, refer to:
- [Workflow & Commits](../../../docs/agent/WORKFLOW.md)
- [Code Style](../../../docs/agent/CODE_STYLE.md)
- [Verification Guide](../../../docs/agent/RUNNING_AND_VERIFYING.md)

Detailed subsystem specifications are maintained in reference documentation:
- Database, migrations, and sync: [data-and-sync.md](../../../docs/reference/data-and-sync.md) & [sync.md](../../../docs/reference/sync.md)
- Deck storage and validation: [decks-storage.md](../../../docs/reference/decks-storage.md)
- Plain-text mirror: [text-mirror.md](../../../docs/reference/text-mirror.md)
- Image caching & protocols: [image-cache.md](../../../docs/reference/image-cache.md)
- Multi-window management: [multi-window.md](../../../docs/reference/multi-window.md)
- Card scanner: [card-scanner.md](../../../docs/reference/card-scanner.md)

---

## 1. Architecture & Core Re-Exports

- **Engine separation**: Most modules have moved to `crates/grimoire-core`. Desktop modules under `apps/desktop/src-tauri/src/<module>/mod.rs` re-export core logic via `pub use grimoire_core::<module>::*;` and append desktop `#[tauri::command]` wrappers.
- **`AppState` structure**: `AppState` wraps `State` (`Arc<State>`) via `Deref`. Holds desktop-specific fields: `mirror` (filesystem mirror), `mirror_status`, and `changes` (multi-window synchronization).
- **Command implementation rules**:
  - Functions in `grimoire-core` take `&Connection` (or `&State`) and return plain DTOs or `Result`.
  - Desktop wrappers in `src-tauri` unpack Tauri arguments and handle window/state routing.
  - Adding a command requires updating core logic, registering the desktop wrapper in `generate_handler!`, and verifying table alignment.

---

## 2. Command Table Synchronization

Desktop commands registered in `generate_handler!` are verified against `grimoire-core`'s command table by `src/command_table.rs`:
- Every registered command must either exist in `grimoire_core::commands::TABLE` or be categorized in `command_table::DESKTOP_ONLY` with an explicit rationale.
- Core commands absent from desktop registration must be listed in `command_table::TABLE_ONLY` (e.g. `card_image_source` for web service workers). Never add dead desktop wrappers solely to bypass this check.
- Commands not yet ported to the shared table reside temporarily in `command_table::NOT_YET`.
- **A wrapper that takes the raw `tauri::ipc::Request` must be on `command_table::RAW_BODY`**, and its table entry must be of kind `bytes` with no named argument (`scanner_frame`, `scanner_capture`). The argument-parity test cannot see a body and its headers — Tauri fills the `Request` in — so that list is what holds them. The test reads the wrapper of every command `generate_handler!` registers, table or not; a raw-body command with no table entry fails it until the list is taught that case.
- **The scanner's wrappers (`src/scanner/mod.rs`) hold no logic of their own.** Each fetches what only Tauri has — the state, the calling webview's label for the lease, the raw request — and calls the core function the table's entry of the same name calls (`ScannerState::{status, frame, reset, set_filters, capture}`, `scanner::{save_prefs, save_tray, commit_tray, archive_tray}`; the body is read by `scanner::frame_from` / `capture_from`). A change to what a scanner command does belongs in `crates/grimoire-core/src/scanner.rs`. The two for the scanner's files — `scanner_assets`, `scanner_assets_fetch` — are wrappers over `grimoire_core::scanner_assets::{owed, fetch}` and take no lease; a release build embeds the files (`scanner::compiled`), owes nothing, and so never fetches. `scanner_submit` is the same: a wrapper over `grimoire_core::scanner_submit::submit` with one ordinary argument (a scan is a run of frames, base64 text inside it, so it is not on `RAW_BODY`) and no lease — the one command that sends camera pictures off the computer, called only from a reader's press on Send, and never with a single picture.

---

## 3. Database Architecture (`user.db` + `corpus.db`)

The desktop manages two SQLite databases in the application data folder:
- **`user.db` (`main`)**: Stores user data (decks, collection, wishlist, tags, settings). Opened as the primary database; never deleted or wiped.
- **`corpus.db` (`corpus`)**: Attached as `corpus`. Contains public card data, printings, legality masks, combos, and price lists. Disposable and rebuildable from external feeds.
- **Corpus lifecycle & repair**:
  - `schema::prepare_data_dir` validates database readiness before creating state connections.
  - Corrupted or unmigratable `corpus.db` files are deleted and recreated at head automatically; `user.db` is never deleted.
  - DDL statements targeting corpus tables must be explicitly schema-qualified (`schema::on_schema`).
  - Gzip BLOB safety: `raw` in `cards` is stored as compressed gzip bytes; never use bare `json_extract(raw, ...)` in SQL migrations (causes fatal malformed JSON errors). Use `schema::json_raw`.
  - Atomicity boundaries: `CrossFileFence` enforces that transactions do not span across `user.db` and attached `corpus.db` without explicit synchronization.
- **Connection pooling**:
  - Read/write connection (`AppState.db`) and dedicated read-only connection (`AppState.db_read`).
  - Auxiliary connections for facet indexing (`index::lifecycle`) and the background mirror (`mirror::watch`). All connections attach both databases.

---

## 4. Desktop Host Subsystems

### Plain-Text Mirror (`src/mirror/`)
- Background thread synchronizes decks and collection to plain-text files on disk.
- Listens to database commits via `WriteObserver`. Corpus swaps trigger full resynchronization.
- Employs dedicated Rust export writers in `apps/desktop/src-tauri/src/transfer/`, validated for byte-for-byte parity against TypeScript export logic via `__golden__/` files.

### Images & `mtgimg://` Protocol
- Custom protocol handler `images::answer` serves cached images or placeholders directly to webviews.
- Background upkeep thread (`spawn_upkeep`) periodically triggers `images::upkeep_tick` to evict stale image files.

### Device Sync & Relay Networking
- Manages encrypted device pairing (`sync_pair/`) and delta synchronization (`sync_engine/`).
- The persistent WebSocket to the relay is `grimoire-core`'s: `sync_engine::live::run` (the connection manager) over `platform::socket`. `desktop.rs` spawns it after `startup::settle` with the write wake it registered as an observer; `src-tauri`'s `sync_engine::live` re-exports the core's module and keeps only the bounded push on exit (`anything_pending`, `push_now`).
- Database changes are captured via SQLite triggers (`sync_ops`) and applied atomically during sync pulls.

### Multi-Window Coordination & In-App Updates
- Secondary windows receive change notifications via `changes.rs`.
- Commit hooks publish change masks (`MirrorMask`, `WindowChanges`) without blocking the main database transaction.
- Portable updater (`src/update.rs`): executes atomic application binary replacement without requiring elevated installers.

### Tauri Capabilities (`capabilities/desktop.json`)
- What the webview is granted, and nothing more: `core:default` (the one `:default` allowed), the opener pair `opener:allow-open-url` + `opener:allow-default-urls` (URLs only, no `allow-reveal-item-in-dir`), `clipboard-manager:allow-write-text` (write only, never read), the four window controls (`core:window:allow-minimize`, `-toggle-maximize`, `-close`, `-start-dragging`), the two `snap-layout:` bounds permissions, and the three `mcp-bridge:` permissions.
- **No `dialog:` and no `fs:` permission, deliberately (issue #545).** Rust opens every file dialog and does every read and write (`src/file_dialog.rs`); no command takes a path from the page and no path crosses IPC in either direction. A capability gates plugin commands, not the arguments of the app's own `#[tauri::command]`s, so a page-side dialog grant was never a fence — it would only let a script put a native window over the app. Do not add either back; a new file command takes its `WebviewWindow` and opens its own dialog through `file_dialog::modal_to`/`show`.
- Held by tests in `desktop.rs`: `the_desktop_capability_is_the_permission_set_that_shipped` pins the exact list above (a change to it is a decision, made in that test on purpose), `the_capability_directory_is_exactly_the_desktop_file` refuses a second capability file, and `the_capability_grants_no_dialog_no_filesystem_and_only_the_clipboard_write` / `the_capability_grants_no_default_but_core_s` / `the_opener_opens_urls_and_nothing_on_disk` hold the individual rules.

---

## 5. Build, Test, and Verification Commands

Execute verification tests only at the end of a feature (not after each change):

| Command | Action |
| --- | --- |
| `cargo test -p mtg-grimoire` | Run desktop host unit and integration tests |
| `cargo test -p mtg-grimoire command_table::` | Verify command table synchronization |
| `cargo test -p mtg-grimoire transfer::` | Run export writer golden parity tests |
| `cargo clippy -p mtg-grimoire -- -D warnings` | Run desktop Clippy lints |
| `cargo fmt -p mtg-grimoire` | Format crate (never run `cargo fmt --all`) |

Test file isolation:
- Tests that need file access must use `crate::scratch::path`, never `std::env::temp_dir()`, to prevent collisions across concurrent test runs.
