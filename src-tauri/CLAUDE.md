# src-tauri — the Rust core

**Rust owns data plumbing** (SQLite/FTS5, Scryfall sync, image cache, the `mtgimg://`
protocol). **TS owns domain logic** (deck validation, import/export parsing). Rust supplies
_facts_; TypeScript draws _conclusions_. Keep that boundary.

`cargo test` and `cargo clippy -D warnings` run from here; `npm run verify` at the root runs
both plus the frontend.

## Hard rules — database

- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with
  `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign
  key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang`
  (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE`
  deletes the user's collection on the next refresh. Orphans are _flagged_, never deleted.
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
  expression, wrapping the _argument_ — never as a `WHERE` term, because the planner
  orders `WHERE` terms as it likes and evaluating the unguarded one _is_ the error. This
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
- **A new migration step goes at the _bottom_ of the ladder, and takes the
  `CARDS_INDEXES` replay from the step below it.** `migrate` reads `user_version` **once**
  and then walks every block above it, so position in the file is the order of execution
  and the number is only the gate — a higher-numbered block placed above a lower one commits
  its version and then has the lower block write back over it. Only the newest step may
  create from `CARDS_INDEXES`, which describes the table _at head_; a step that _changes_ an
  index definition must `DROP` it first or the widening is a silent no-op on exactly the
  machines that need it. Schema is at **v10** — see
  [the ladder's history](../docs/reference/data-and-sync.md).

## Hard rules — user data

- `collection_entries`/`wishlist_entries`/`card_migrations`/`deck_cards` reference `cards.id`
  **softly** and denormalize `set_code`/`collector_number`/`lang` (and `name`, on the wishlist
  and on deck cards) — as does `decks.cover_card_id`. A row whose card vanishes is **flagged**
  (`needs_review`, a sentence) and never deleted — `reconcile::sweep_orphans` runs after every
  ingest over all three user card tables and clears the flag if the card returns.
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
  are CHECK-constrained in SQL _and_ validated in Rust, and the imported string is kept in
  `condition_original`.
- **A finish's price is a lookup in the `prices` blob** (`usd`/`usd_foil`/`usd_etched`;
  `eur_etched` does not exist, so etched is unpriced in EUR). `cards.price_usd` is a
  sort/display fallback chain and must never be summed. `tix` is never summed with fiat.
- **Every price field ships a EUR twin beside its USD one, and Rust never picks between
  them** — the marketplace setting is the frontend's to read, so a query that returned one
  currency would make switching a refetch instead of a re-render. The one exception is
  `ORDER BY`, which happens inside SQLite: `SearchRequest`/`CollectionQuery`/`WishlistQuery`
  carry a `currency`, and **anything that is not exactly `"eur"` is USD** — absent, null, a
  number, `"EUR"` — because a future marketplace id must not fail the whole request.
  `sorting::sorts_for` splits each whitelist into shared and priced halves so a new money
  sort cannot be added to dollars and silently forgotten in euros.
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

## Hard rules — decks (storage side)

Full detail, with the measurements and the traps behind each rule, is in
[docs/reference/decks-storage.md](../docs/reference/decks-storage.md). The binding rules:

- **Enforced foreign keys exist only _between user tables_, never against `cards.id`.** The
  `ON DELETE` action is chosen per delete-site: **CASCADE** where a row has nowhere else to be
  (`deck_cards.deck_id`/`.category_id`, both `deck_allocations` keys, `deck_categories.deck_id`,
  `deck_tags.deck_id`, `deck_audit.deck_id`, `deck_folders.parent_id`), **SET NULL** on exactly
  two — `decks.folder_id` and `deck_cards.tag_id`, because deleting a folder must not delete the
  decks in it and deleting a tag must never delete a card.
- **The grain is `deck_id, variant, category_id, card_id`** (`schema::DECK_CARD_GRAIN`).
  `variant` is `live` (sleeved up) or `theory` (being built toward); every card command takes
  both. `deck_cards` has `CHECK (quantity > 0)`, so zero removes the row.
- **`deck_allocations` carries no variant column**, so a `theory` read would walk the _live_
  deck's claims — `attribute_owned` filters `variant == LIVE` explicitly. `allocate_deck` claims
  for `live` only.
- **`is_active = 0` is the whole of what `maybe` used to mean**, and **nothing anywhere may
  branch on the kind being `maybe`.** The user names, reorders, switches off and deletes their
  own categories; the fixed word survives only as `deck_categories.kind`
  (`schema::CATEGORY_KINDS`).
- **`format_specs` is data, not code.** A rules change is a new migration step re-running the
  seed constant, never an engine branch; a new format is a row. Never derive one format from
  another.
- **The allocator runs on five writes and nothing else** — a card write, the Built toggle,
  `missing_to_wishlist`, `set_category_active`, `delete_category`. Growing the collection does
  _not_ re-run it, so a deck reads new copies only after its next allocator run.
- **Writing history is not a command.** `deck_audit::record(tx, …)` is called _inside the
  caller's already-open transaction_, which is what makes a rolled-back write leave no history.
  The only IPC is the read, `deck_audit_list`, whose limit is `clamp(1, 500)` — **the low end is
  load-bearing, because SQLite reads a negative `LIMIT` as no limit at all.** The table holds
  facts; `src/features/decks/auditText.ts` is the only thing that words them.
- **Two fences every deck write opens with, neither enforced by the DDL**: the variant must be
  one the schema knows, and the category must belong to _this_ deck — `deck_cards.category_id`'s
  FK only asks that the category exist, not whose it is.

## Scryfall and the network

The rules, and where each is enforced, are in
[docs/reference/scryfall.md](../docs/reference/scryfall.md). What binds every call site:

- **`scryfall::Client::api_send` is the only way this module issues an API request** — it
  refuses inside a lockout, waits out the endpoint's interval, adds `Accept`, and retries.
  Every `api.scryfall.com` request needs real `User-Agent` + `Accept` headers.
- **Pacing sleeps, a 429 refuses**, a 429 is remembered across a restart, and retry is for
  5xx/timeouts only — **never a 429** (the docs forbid exactly that) and never a 404.
- **Bulk data is the only card source**, gzipped **JSONL** (one object/line; old JSON-array
  endpoints 404). There is no per-card API lookup anywhere.
- Scryfall's shapes: `cards.oracle_id`/`cmc`/`type_line` are NULLABLE, `collector_number` is
  TEXT, prices are decimal strings, `legalities` is JSON (23 keys, grows), finishes are an enum
  and never a boolean.
- Failures fold into `error_log` through `errors::record`, which returns `()` and is called
  inside the caller's transaction — it can never fail the thing it describes.

## Images and the `mtgimg://` protocol

Details and every measurement: [docs/reference/image-cache.md](../docs/reference/image-cache.md).

- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where the
  origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere. Variants
  are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never fetched.
  The handler reads through `db_read`, never the write connection.
- `app.security.csp` is not `null` — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
- `cards.scryfall.io` is the **only** host images come from; an off-host URI is refused. A URI
  with no `?<epoch>` cache-buster is refused at resolution, and `is_current` compares that
  stored URI character for character — that is the whole of freshness.
- The second route is `/cover/<deckId>`, which touches Scryfall not at all. The `i64` parse is
  the whole path-traversal fence, since the id becomes a filename.

## Tauri capabilities

- **`@tauri-apps/plugin-dialog` is here for exactly one thing — choosing a deck cover — and the
  capability says so.** `capabilities/default.json` grants **`dialog:allow-open`**, one command,
  not `dialog:default`'s five: save, message, ask and confirm are unreachable from the webview
  however the plugin is initialised. The contract that makes this enough is that
  `deck_set_cover_image` takes a **path**, not bytes — the page asks for a name and Rust opens
  the file, so no filesystem permission of any kind is needed. **`tauri-plugin-fs` and `rfd`
  entered `Cargo.lock` transitively** as that plugin's own dependencies and are **unreachable**:
  `tauri_plugin_fs::init()` is never called (the three registrations are single-instance, opener
  and dialog) and **no `fs:` permission is granted anywhere**, so the ACL would deny them even if
  it were. Adding a plugin means adding its narrowest permission, never its `:default`.
- `tauri.conf.json` is embedded at **compile time** — editing it needs a Rust rebuild
  (`touch src-tauri/src/main.rs`), not just a dev-server restart. `"dragDropEnabled": false` is
  load-bearing; re-enabling it kills all in-app drag-and-drop on Windows.

## Further reading

| Doc | What it holds |
| --- | --- |
| [data-and-sync.md](../docs/reference/data-and-sync.md) | Data dir, sync timings, the schema ladder, every search-performance measurement |
| [scryfall.md](../docs/reference/scryfall.md) | Rate limits, the penalty, bulk data, `error_log`, pre-warm keys |
| [image-cache.md](../docs/reference/image-cache.md) | Cache layout, concurrency, placeholders, the cover route |
| [search-faceting.md](../docs/reference/search-faceting.md) | `src/index/` — why the index is in memory, and the fail-open rule |
| [in-app-updates.md](../docs/reference/in-app-updates.md) | `update.rs` — why the portable swap is hand-written |
| [decks-storage.md](../docs/reference/decks-storage.md) | The deck tables, the six card commands, the allocator, the audit log |
