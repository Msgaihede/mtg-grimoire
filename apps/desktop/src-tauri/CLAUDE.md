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
- **`AppState` structure**: `AppState` wraps `State` (`Arc<State>`) via `Deref`. Holds desktop-specific fields: `mirror` (filesystem mirror), `mirror_status`, `mirror_pass` (one mirror pass at a time — the thread's and `Rebuild now`'s), and `changes` (multi-window synchronization).
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
- **The scanner's wrappers (`src/scanner/mod.rs`) hold no logic of their own.** Each fetches what only Tauri has — the state, the calling webview's label for the lease, the raw request — and calls the core function the table's entry of the same name calls (`ScannerState::{status, frame, reset, set_filters, capture}`, `scanner::{save_prefs, save_tray, commit_tray, archive_tray}`; a frame's body — the JPEG, with its full-resolution copy behind it when `x-scanner-full` says where the frame ends — is read by `scanner::frame_from`, and a capture's by `scanner::capture_from`). A change to what a scanner command does belongs in `crates/grimoire-core/src/scanner.rs`. The scanner's files are the Neural recogniser's, compiled into every build through `card-neural`'s `bundled` feature and carried to the core as the app starts; nothing is downloaded and there is no `cfg(scanner_assets)` since 2026-10-24. `scanner_submit` is the same: a wrapper over `grimoire_core::scanner_submit::submit` with one ordinary argument (a scan is a run of frames, base64 text inside it, so it is not on `RAW_BODY`) and no lease — the one command that sends camera pictures off the computer, called only from a reader's press on Send, and never with a single picture.

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

### Shares and the integrations store

- `src/share/` re-exports `grimoire_core::share` (the snapshot, the `collection_shares` cache and the publish requests, the core's since issue #1396) and keeps the `share_*` Tauri commands and the viewer of a stranger's link (`share/publish.rs`: same-origin redirects, counted body caps, one wall clock — issue #545's bounds). The goldens in `share/__golden__/` stay byte-identical; they fence the core's readers.
- `desktop.rs` spawns the core's publish round (`integration::publish::run`) beside `live::run`: after each successful sync trip it refreshes the group's live shares and, when the group's integrations store exists, its `Projection v1` tables. There is no share timer and no `share_auto_update` any more. Reference: [integrations-store.md](../../../docs/reference/integrations-store.md).

### The local MCP server (`src/mcp/`)
- Issue #1395 (issue #1396's PR 1). Reference: [local-mcp-server.md](../../../docs/reference/local-mcp-server.md). A streamable-HTTP MCP endpoint at `http://127.0.0.1:{port}/mcp` (port 39147 by default), served by this process on `hyper` while Settings → Integrations has it on; `desktop::start` resumes it after `startup::settle`. Free and desktop-only; its seven commands (`mcp_status`, `mcp_enable`, `mcp_disable`, `mcp_rotate_token`, `mcp_set_port`, and Claude Desktop's `mcp_claude_desktop_install` / `_save`) are on `command_table::DESKTOP_ONLY`. The switch, port and token are `app_meta` `mcp_server`, never synced.
- **Claude Desktop's one-click install** (`mcp/claude_desktop.rs`): an MCP Bundle (`.mcpb`) — the manifest with the address and token in `mcp_config.env`, the dependency-free stdio→HTTP bridge `mcp/claude_desktop/server.js` (run on Claude Desktop's own Node.js), the icon — written to `<data dir>/mcp/` and opened **by this process** through the opener's Rust API, or saved through `file_dialog`. The page gets no file opener and no path.
- **Every tool is a translation onto `grimoire_core::commands::dispatch`** (`mcp/tools.rs`) — never SQL of its own, so a tool answers what the light app's hosts answer. The exceptions are the read graph's three (`graph_schema`, `graph_validate`, `graph_query`), which are `crates/grimoire-graph`'s doors over the one `graph::graph()` the page's `graphql_query` also answers from ([graphql.md](../../../docs/reference/graphql.md)). Writes are adds only (collection, wishlist, a deck's pile), 1–99 copies, and each emits `db:changed` itself naming the tables it touches, because `changes::spawn_emitter` emits only while a second window is open.
- **A request meets five gates before its body is read** (`mcp/http.rs::gate_request`): a loopback `Host` with this port (DNS rebinding), no web page's `Origin`, `POST /mcp`, the bearer token in constant time, 1 MiB. No CORS header is ever sent. Do not loosen the first two because the token is there: a write needs no answer read.

### Draft & Packs (`src/draft/`, `src/packs/`)

- Spec: [2026-10-29-draft-and-packs-design.md](../../../docs/superpowers/specs/2026-10-29-draft-and-packs-design.md) §2, §4–§6. Every command is on `command_table::DESKTOP_ONLY`; the TS mirrors are `packages/ui/lib/ipc/draft.ts` and `packs.ts`.
- **One draft at a time** (`draft::DraftSlot`, managed): the playtest slot's shape — the page names each draft (`draft: u64`), a call naming a replaced one is refused, a second call while one is on the engine is told the table is busy (the lobby's task waits its turn instead, `on_draft_waiting`). **Every `Draft` call that can let a bot pick runs on `grimoire_play::on_engine_stack`** on the blocking pool. Facts are `play::cards_by_ids` (converted by `playtest::facts`) plus each printing's set, number and rarity from `cards`.
- **A solo draft is kept after every change** in `app_meta` `draft_session` — `{snapshot, updatedAt, saved}` (`SavedRow`; `saved` is the `DraftSaved` _Draft in progress_ draws, so `draft_saved` reads it without a restore). `draft_resume` restores it (facts through `Draft::card_ids`); `draft_end` drops it unless a newer draft is at the table. A pod is never kept. A save that finishes after its draft was ended does not write the row back (`Shared::saving`).
- **The draft deck** (`draft::deck`): wrappers over `grimoire_core::draft_deck`, each write under `with_write` like every deck write.
- **Commander and Winston drafts** (spec §4a): `draft_start` deals `commander` and `winston` as it
  deals the others (and refuses `pod`, which `lobby_start` deals, in any `podFormat`). A Commander
  pick is `draft_pick` / `lobby_pick` with two ids. A Winston turn is `draft_winston(draft, pile,
take)` — this reader's seat, solo or the host's own turn in a pod, kept like a pick — and
  `lobby_winston(pile, take)` for a guest (body `{"v":1,"kind":"winston","pile":n,"take":bool}`,
  applied by the host to that peer's seat, views sent as after a pick). `draft_deck_create` takes
  `commander`: a Casual deck with an empty Commander pile.
- **The lobby** (`draft::lobby`, `LobbySlot`, managed): one lobby and one task on Tauri's runtime over the desktop's own `tokio-tungstenite` (the core's exact version and features — no second copy in `Cargo.lock`). `lobby_create` asks `entitled` and then the relay's token through the lane, as `scanner_submit` does, and none of its sentences names a membership; joining needs only the code. The command waits for the first frame (`peers` / `welcome`), so a refusal is the command's error. The task: protocol ping every 30 s (a peer that has answered one and misses the next is a drop), up to six reopenings with backoff (a guest with `rejoin`), close codes as sentences (`closed_reason`). A host applies a guest's pick and sends every guest its own view after any change, broadcasts `room` on every roster change and seats `set_connected` from `peers`; a kick after the start gives the seat to a bot. Frames, bodies and the state machine (`decode`, `react`) are pure and unit-tested.
- **A game's lobby** (issue #1419, `LobbyKind::Game`; `lobby_create(name, kind)`): the same lobby and task seat a Playtesting game. A guest sends its deck (`lobby_deck`: printings and counts, body `deck`), which the host keeps per peer (`Live::decks`) and names in the room (`LobbyPeer.deck`); `lobby_game_start` checks the seats (`playtest::lobby::table`), reads every deck in the host's card data (a guest's through `play::cards_by_ids`), deals into the playtest slot, locks the lobby and sends each guest its first step. The host plays with `playtest_act`, which sends every guest its step after each change (`send_game_steps`); a guest's `lobby_act` (body `act`) is applied by `playtest::lobby::play` on the engine's stack, **waiting its turn** while the host's board has the game (`with_game`), and answered as `playtest:step` (`HostStep`) to the host's page and a packed `game` body (gzip in base64, `pack`) to each guest, emitted there as `lobby:game` (`GuestGame`); a refusal goes to that guest alone (`refused` → `lobby:refused`). `lobby_kick` of a seated guest hands its seat to the AI (`Playtest::hand_to_ai`). A guest's deck text is never taken: a printing the host's card data lacks refuses the deal.
- **A trade's lobby** (`LobbyKind::Trade`; `lobby_create(name, kind, trade)`, `lobby_join(code, name, trade)` — `trade` is the reader's own open trade, `LobbyState.trade`): two readers build one trade, each on their own copy. The host's app holds the deal (`trade::lobby::TradeDeal`: both offers, a `rev`, each acceptance), locks the lobby once a guest is in and kicks a second. A guest sends `offer` (`TradeOfferLine`s, `tidy`'d to 300) and `accept` (`rev`, `yes`); the host answers with `deal`. Each app writes the other's offer as `theirs` on its copy (`grimoire_core::trade::replace_side`, under `with_write`; unknown printings counted, `LobbyTrade.unknown`). `lobby_trade_offer` reads the copy's `mine` side (`trade::side_offer`) and sends it — unchanged, it moves nothing; `lobby_trade_accept(rev, accept)` refuses a stale `rev`. Both accepted one `rev` → `LobbyPhase::Agreed`, final; each reader then finishes their own copy with `trade_finish`. Reference: [trades.md](../../../docs/reference/trades.md) §8.
- **Events**: `lobby:state` (`LobbyState`) on every lobby change; `draft:view` (`DraftView`) — on a host when a guest's pick (or a seat's connection) moved seat 0's view, on a guest for every view the host sends.
- **MTGJSON** (`packs::packs_booster_set`): `https://mtgjson.com/api/v5/{CODE}.json.gz`, the code validated (2–6 alphanumerics) before a URL is built, cached at `<data dir>/boosters/{CODE}.json.gz` for a week (the file's mtime is `fetchedAt`), a stale copy used when MTGJSON cannot be reached and no refresh was asked; source sets fetched beside it and skipped on failure; the gunzip and the parse on the blocking pool; the app's `User-Agent`.

### Multi-Window Coordination & In-App Updates

- Secondary windows receive change notifications via `changes.rs`.
- Commit hooks publish change masks (`MirrorMask`, `WindowChanges`) without blocking the main database transaction.
- Portable updater (`src/update.rs`): executes atomic application binary replacement without requiring elevated installers.
- **Every update is verified twice before anything is unpacked or run**: GitHub's `digest` (integrity), then a minisign signature against the compiled-in `SIGNING_PUBLIC_KEY` (key id `6C7487F8990F0A73`) with the trusted comment `mtg-grimoire <version> <portable|nsis>`. Both fail closed. Signed by `release.yml`'s `attach` job with `scripts/update-signing.ts`; key setup and rotation order: [`docs/reference/in-app-updates.md`](../../../docs/reference/in-app-updates.md).

### Tauri Capabilities (`capabilities/desktop.json`)

- What the webview is granted, and nothing more: `core:default` (the one `:default` allowed), the opener pair `opener:allow-open-url` + `opener:allow-default-urls` (URLs only, no `allow-reveal-item-in-dir`), `clipboard-manager:allow-write-text` (write only, never read), the four window controls (`core:window:allow-minimize`, `-toggle-maximize`, `-close`, `-start-dragging`), the two `snap-layout:` bounds permissions, and the three `mcp-bridge:` permissions.
- **No `dialog:` and no `fs:` permission, deliberately (issue #545).** Rust opens every file dialog and does every read and write (`src/file_dialog.rs`); no command takes a path from the page and no path crosses IPC in either direction. A capability gates plugin commands, not the arguments of the app's own `#[tauri::command]`s, so a page-side dialog grant was never a fence — it would only let a script put a native window over the app. Do not add either back; a new file command takes its `WebviewWindow` and opens its own dialog through `file_dialog::modal_to`/`show`.
- Held by tests in `desktop.rs`: `the_desktop_capability_is_the_permission_set_that_shipped` pins the exact list above (a change to it is a decision, made in that test on purpose), `the_capability_directory_is_exactly_the_desktop_file` refuses a second capability file, and `the_capability_grants_no_dialog_no_filesystem_and_only_the_clipboard_write` / `the_capability_grants_no_default_but_core_s` / `the_opener_opens_urls_and_nothing_on_disk` hold the individual rules.

---

## 5. Build, Test, and Verification Commands

Execute verification tests only at the end of a feature (not after each change):

| Command                                       | Action                                      |
| --------------------------------------------- | ------------------------------------------- |
| `cargo test -p mtg-grimoire`                  | Run desktop host unit and integration tests |
| `cargo test -p mtg-grimoire command_table::`  | Verify command table synchronization        |
| `cargo test -p mtg-grimoire transfer::`       | Run export writer golden parity tests       |
| `cargo clippy -p mtg-grimoire -- -D warnings` | Run desktop Clippy lints                    |
| `cargo fmt -p mtg-grimoire`                   | Format crate (never run `cargo fmt --all`)  |

Test file isolation:

- Tests that need file access must use `crate::scratch::path`, never `std::env::temp_dir()`, to prevent collisions across concurrent test runs.
