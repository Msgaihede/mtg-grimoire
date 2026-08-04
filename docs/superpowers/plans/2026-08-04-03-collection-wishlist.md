# Plan 3/6: Collection & Wishlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The app stops being a card browser and starts being a collection tracker: `collection_entries` and `wishlist_entries` at spec §6's grain, quick-add from every surface that shows a card, a Collection view with real aggregates (value read per finish from the `prices` blob), a Wishlist view with owned badges back in search — and the two foundations that make user writes safe: an ingest that no longer holds the write connection for 44 seconds, and the v3 database bundle the Plan 2 review ledgered.

**Architecture:** Two migration steps. **v3** finishes the `cards` table: an `artist` column (backfilled from the `raw` JSON already on disk, which removes `raw`'s last runtime reader) and `raw` written as a gzip BLOB from the ingest onward. **v4** adds the user tables — `collection_entries`, `wishlist_entries`, `card_migrations` — with `card_id` as a **soft** reference and `set_code`/`collector_number`/`lang` denormalized beside it, so a sync that drops `cards` cannot touch them. The ingest is restructured to parse outside the write lock and commit in 2 000-row batches, so a collection edit waits one batch instead of one sync. New Rust modules: `collection.rs` and `wishlist.rs` (CRUD + list + per-finish valuation), `filters.rs` (the card predicates, shared by search and collection), `reconcile.rs` (Scryfall `/migrations`: repoint merges, flag deletes, never delete a user row), `maintenance.rs` (the one-time `auto_vacuum` conversion and the post-swap `incremental_vacuum`). React gains `src/features/collection/` and `src/features/wishlist/`, built from the search view's own patterns. Spec: `docs/superpowers/specs/2026-08-04-mtg-collection-tracker-design.md` §6 (data model) and §7 (Collection/Wishlist), plus §4.7 (migrations reconciler) and §5 (pre-warm). Carryover: `docs/superpowers/notes/plan-2-carryover.md`.

**Tech Stack:** Tauri 2.11.5, React 19, TypeScript 6.0.x, Vite 7, Tailwind CSS v4, TanStack Query 5, @tanstack/react-virtual 3, zustand 5, rusqlite 0.40 (bundled, FTS5), flate2 1, reqwest 0.12 (rustls, stream), tokio 1 (fs/io-util/rt/sync/time), tauri-plugin-single-instance 2, serde_json, Vitest 4, httpmock 0.8. No new npm or crate dependencies.

## Global Constraints

Binding values, copied verbatim from the sources that own them. Do not paraphrase them into code.

**CLAUDE.md database invariants** — this plan is the first one to add *user* tables, which is what invariant one exists for:

- **`cards` is dropped and recreated on every sync** (`schema::swap_staging`, with `foreign_keys=ON`). So: user tables reference `cards.id` **without an enforced foreign key** — a soft reference plus denormalized `set_code`/`collector_number`/`lang` (spec §6). A declared `REFERENCES cards(id)` aborts every sync; `ON DELETE CASCADE` deletes the user's collection on the next refresh. Orphans are *flagged*, never deleted. **`collection_entries`, `wishlist_entries` and `card_migrations` all obey this: `card_id TEXT NOT NULL` with no `REFERENCES` clause, and Task 4 ships the swap-survival test for each.**
- Every index on `cards` goes in `schema::CARDS_INDEXES` — the swap drops the table with its indexes and replays only that list. **The v3 `artist` column is not indexed and the user tables are not `cards`, so `CARDS_INDEXES` is untouched by this plan.**
- `CARDS_COLUMNS` is **frozen**: it is what schema v1 created, not what `cards` is now. Add columns in a new `if v < N` step in `migrate` with `ALTER TABLE`. (`create_staging` derives its layout from `PRAGMA table_info(cards)`, so staging follows automatically.) **Task 2 adds `if v < 3`; Task 4 adds `if v < 4`; neither touches `CARDS_COLUMNS`.**
- `cards_fts` is **external-content with no triggers**. Any write to `cards` outside the ingest path needs `INSERT INTO cards_fts(cards_fts) VALUES('rebuild');` **if it touches an indexed column (`name`/`type_line`/`search_text`) or renumbers rowids** — and `VACUUM` may do the latter, so it always needs one. **The v3 backfill writes one new unindexed column and renumbers nothing, so it does not rebuild (same reasoning as v2, same style of test). `maintenance::convert_to_incremental` runs `VACUUM` and therefore rebuilds, unconditionally — that is why Task 3 makes `create_fts` `pub`.**
- Two connections: `AppState.db` writes, `AppState.db_read` is `SQLITE_OPEN_READ_ONLY`. Reads go through `db_read` so a search is not stuck behind a 44 s ingest. **Every collection/wishlist *read* command goes through `db_read`; every *write* command takes `AppState.db` through `db::lock_for(&state.db, WRITE_LOCK_WAIT)` and answers honestly if it cannot get it.**

**Finishes — a strict enum, never a boolean** (research doc, §Collection model conventions: *"finishes: strict enum nonfoil|foil|etched (never boolean — #1 importer data-loss bug)"*):

```
nonfoil | foil | etched
```

**Conditions — the NA scale, five grades, `NM` the default** (spec §6, research doc):

```
NM | LP | MP | HP | DMG
```

The synonym table that normalizes an imported string, verbatim from the research doc, with the original string always preserved in `condition_original`:

| incoming | normalizes to |
|---|---|
| `Mint`, `M`, `MT`, `Near Mint`, `NM`, `NM-Mint` | `NM` |
| `SP`, `Slightly Played`, `Excellent`, `EX`, `Lightly Played`, `LP`, `Good (Lightly Played)` | `LP` |
| `Moderately Played`, `MP`, `Played`, `PL`, `Good`, `GD` | `MP` |
| `Heavily Played`, `HP`, `Poor`, `PO` | `HP` |
| `Damaged`, `DMG`, `DM`, `D` | `DMG` |

**`LP` is a false friend between scales** (research doc): Cardmarket's `LP` sits at NA *Played*, i.e. `MP`–`HP`. A **bare** `LP` normalizes to `LP` here, because that is what the NA scale — the app's own — means by it. Re-reading it as `MP` is a property of the *source file*, so it belongs to the importer in Plan 5, where the source is known. `EX` → `LP` and `GD` → `MP` are in the table above because those two spellings only ever come from the EU scale.

**Row grain** (research doc): `(scryfall_id, finish, condition, language, flags) → quantity + tradelist_quantity`, flags = `altered`, `signed`, `proxy`, `misprint`. Serialized cards carry a **user-supplied** `serial_number` (`042/500` is not in Scryfall's data) and graded cards a `grading` JSON, and two copies that differ in either are two rows — so both join the unique grain through `coalesce(…, '')`, because SQLite treats NULLs in a UNIQUE index as distinct and would otherwise let a second NULL-serial duplicate straight through.

**Prices — read the blob per finish. NEVER `price_usd`.** The `prices` JSON has six keys (`usd, usd_foil, usd_etched, eur, eur_foil, tix`) holding decimal **strings**; `eur_etched` is documented but **does not exist in the data**. The mapping, in both languages:

| finish | USD key | EUR key |
|---|---|---|
| `nonfoil` | `usd` | `eur` |
| `foil` | `usd_foil` | `eur_foil` |
| `etched` | `usd_etched` | **none — counts as unpriced** |

`cards.price_usd` is a display/sort fallback chain (`usd → usd_foil → usd_etched`) and would price a nonfoil copy at foil rates; it is never summed and never shown as a finish price. `tix` is never summed with fiat. Every price on screen is labelled with its as-of date (spec §5), and this app has exactly one: `PRICES_AS_OF` — *"Prices as of the last card-data sync."*

**Collector numbers are TEXT and ~9% are not numeric** (`741z`, `1★`, `A-123`, `118†s`, `M21-1`; max length 9). The collection table sorts on them, so the sort is natural:

```sql
ORDER BY set_code ASC, CAST(collector_number AS INTEGER) ASC, collector_number ASC
```

Verified against those exact values while authoring: `A-123, M21-1, 1, 1★, 2, 9, 10, 042, 100, 118†s, 741z`.

**Scryfall `/migrations`** (research doc, Tier 5) — `GET https://api.scryfall.com/migrations?page=1`, fields `id`, `performed_at`, `migration_strategy`, `old_scryfall_id`, `new_scryfall_id` (nullable), `note` (nullable):

- `merge` — *"update your records to replace the given old Scryfall ID with the new ID."*
- `delete` — *"The given UUID is being discarded, and no replacement data is being provided."* → **flag for review, never drop.**

**HTTP conduct** — every `api.scryfall.com` request carries this exact `User-Agent` (`scryfall::USER_AGENT`, already in the source) and `Accept: application/json;q=0.9,*/*;q=0.8`; 403 without them:

```
MTGCollectionTracker/0.1 (https://github.com/markusseerup/mtg-collection)
```

Rate limits: `api.scryfall.com` 10/s general (`/migrations` is in "all other methods"); `*.scryfall.io` explicitly unlimited, image fetching still paced ≤10/s. On **429 back off 30 s** — *"It is not acceptable to ignore HTTP 429 responses."*

**Image policy (unchanged, still binding):** WEBP variants only (`thumb`/`grid`/`display`/`art`); a URI with no `?<epoch>` cache-buster is refused at resolution; `cards.scryfall.io` is the only host images are fetched from; never distort, recolour or crop a card image; wherever art appears without the printed card frame around it, the artist and `Card images © Wizards of the Coast · Data © Scryfall` appear in the same interface.

**Frontend design — binding.** Every UI task in this plan opens by invoking the **`frontend-design` skill**, and `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is a specification, not a mood board: implementers **execute** its palette, type roles, mana line, ribbon layout and chip vocabulary, and spend their judgment on detail quality (spacing, focus states, contrast) rather than on the direction. Concretely, for this plan:

- **Colour appears only where it carries Magic meaning** — mana, colour identity, rarity, card art. A quantity, a price and a condition grade are *data*: Geist Mono, `tabular-nums`, no colour. There is no green "in stock" and no red "missing".
- **The mana line stays the app's only progress bar**, and it is not repeated. The new `compacting` sync phase rides the same line.
- **The global ribbon owns global actions.** Collection and Wishlist filters live with their views, exactly as the search filter row does.
- **Type roles:** Cinzel for view titles and section headers only, never below 18px; Geist for everything else; Geist Mono for collector numbers, prices, quantities and counts.
- **Motion budget:** 150 ms ease on chip/nav/stepper state, the sync sweep, nothing else. Every animation respects `prefers-reduced-motion`.
- **Escape closes one layer per press, and the protocol is a handshake, not a z-index** (CLAUDE.md). The add-to-collection popup is an `"inner"` layer (capture phase + `preventDefault`); the card detail pane stays `"outer"`. Two `"inner"` peers are **not** ordered by this hook — never leave two open at once.
- **Quality floor, unannounced:** visible gold focus outline on every interactive element, AA contrast, works down to 1024px width. Copy is sentence case with verbs on buttons ("Add to collection", "Reset all").

**Process:** all work on `main`, one commit per task, message style `feat:`/`fix:`/`chore:`/`test:`, with the trailer:

```
Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
```

**`npm run verify` must be green before every commit** (build + lint + Vitest + `cargo test`). `npm run lint` runs with `--max-warnings 0`.

## File Structure

```
mtg-collection/
├── CLAUDE.md                                   # M: image-cache rules, user-data invariants,
│                                               #    chunked ingest, gzip `raw`, auto_vacuum order (T14)
├── src-tauri/src/
│   ├── db.rs                                   # M: auto_vacuum before WAL, lock_blocking,
│   │                                           #    WRITE_LOCK_WAIT (T1, T3)
│   ├── ingest.rs                               # M: chunked staging load over &Mutex<Connection>,
│   │                                           #    gzip `raw`, `artist` (T1, T2)
│   ├── card_row.rs                             # M: artist, gzip_raw, raw_json (T2)
│   ├── schema.rs                               # M: SCHEMA_VERSION, migrate v3 (artist),
│   │                                           #    migrate v4 (user tables), create_fts pub (T2–T4)
│   ├── card.rs                                 # M: ARTIST_SQL retired for the column (T2)
│   ├── sync.rs                                 # M: chunked ingest call, incremental_vacuum,
│   │                                           #    compaction + reconciler tail, store_failures (T1, T3, T8, T14)
│   ├── scryfall.rs                             # M: fetch_migrations, image size cap (T8, T13)
│   ├── search.rs                               # M: filters.rs extraction, owned/wishlisted columns,
│   │                                           #    `owned` filter, mana-value dedupe (T6, T7)
│   ├── images.rs                               # M: single-flight per key, collection pre-warm,
│   │                                           #    off-host warning (T13)
│   ├── lib.rs                                  # M: command registrations (T5, T6, T7, T13)
│   ├── maintenance.rs                          # NEW: auto_vacuum conversion, incremental_vacuum (T3)
│   ├── filters.rs                              # NEW: the card predicates, shared by search
│   │                                           #      and collection (T6)
│   ├── collection.rs                           # NEW: CRUD, list, summary, valuation (T5, T6)
│   ├── wishlist.rs                             # NEW: CRUD, list, fulfilment (T7)
│   └── reconcile.rs                            # NEW: /migrations reconciler + orphan sweep (T8)
├── src/
│   ├── index.css                               # M: --color-muted → --color-dim rename (T9)
│   ├── App.tsx                                 # M: mount Collection and Wishlist views (T11, T12)
│   ├── lib/ipc.ts                              # M: collection/wishlist DTOs and commands (T9)
│   ├── lib/store.ts                            # M: collectionView, wishlistView (T9)
│   ├── lib/finish.ts + .test.ts                # NEW: the finish enum, labels, price keys (T9)
│   ├── lib/prices.ts + .test.ts                # NEW: PRICES_AS_OF, usd/eur formatting (T9)
│   ├── lib/tokens.test.ts                      # NEW: the --color-dim rename, pinned (T9)
│   ├── components/RarityGem.tsx + .test.tsx    # NEW: the gem + sr-only label, four call sites (T9)
│   ├── components/FilterChips.tsx + .test.tsx  # NEW: ManaChip, mana-value chips, Reset all,
│   │                                           #      shared by both filter bars (T9)
│   ├── components/QuantityStepper.tsx + .test  # NEW: −/qty/+ with a mono readout (T10)
│   ├── features/card/printings.ts              # M: finish vocabulary moves to lib/finish.ts (T9)
│   ├── features/card/CardDetailPane.tsx        # M: printings rows become add points (T10)
│   ├── features/search/CardGrid.tsx            # M: generic rows + badge slot + tile add button (T10, T12)
│   ├── features/search/SearchPage.tsx          # M: owned/wish badges in the table (T12)
│   ├── features/search/FilterBar.tsx           # M: shared chips, Owned toggle (T9, T12)
│   ├── features/collection/AddToCollection.tsx # NEW: the quick-add popup (T10)
│   ├── features/collection/CollectionPage.tsx  # NEW: summary header, filters, table + grid (T11)
│   ├── features/collection/CollectionTable.tsx # NEW: virtualized rows with inline steppers (T11)
│   ├── features/collection/CollectionSummary.tsx # NEW: the aggregate header (T11)
│   ├── features/collection/useCollection.ts    # NEW: filter state + paged query (T11)
│   ├── features/collection/conditions.ts + .test # NEW: grades, labels, synonym table (T9)
│   └── features/wishlist/WishlistPage.tsx      # NEW: the mirror view, desired quantities (T12)
└── docs/superpowers/plans/2026-08-04-03-collection-wishlist.md   # this file
```

Later plans build on: `collection.rs`/`wishlist.rs` (deck allocations in Plan 4, import commit in Plan 5), `filters.rs` (every list that filters cards), `conditions.ts` (the CSV importers' normalization), `reconcile.rs` (deck rows join the same sweep), and `maintenance.rs` (Plan 6's "Compact database" button).

---

### Task 1: Chunk the ingest so a sync no longer owns the write connection

Plan 2's carryover opens with this and calls it the decision to make *before the first task brief*: `do_sync` holds `AppState.db` for the whole ~44 s ingest, and everything this plan adds writes. The fix is the recommended one — chunk the staging load and release the mutex between batches — which also bounds the ~1.9 GB transient WAL (autocheckpoint can finally run mid-ingest) and gives the exit checkpoint a lock it can actually get.

The bounded-lock fallback stays as the belt: a user write asks for the connection with a 5 s bound and says "busy" rather than freezing a button.

**Files:**
- Modify: `src-tauri/src/db.rs`, `src-tauri/src/ingest.rs`, `src-tauri/src/sync.rs`

**Interfaces:**
- Consumes: `rusqlite::Connection`, `std::sync::Mutex`, `crate::schema::{create_staging, swap_staging}`, `crate::card_row::CardRow`.
- Produces:

```rust
// src-tauri/src/db.rs
/// How long a user-facing write waits for the write connection before it answers "busy".
pub const WRITE_LOCK_WAIT: Duration = Duration::from_secs(5);
/// Take `mutex`, waiting as long as it takes, recovering from poisoning.
pub fn lock_blocking(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection>;

// src-tauri/src/ingest.rs — signature change
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError>;
```

- `sync::lock_conn` keeps its name and its callers, and becomes a one-line delegate to `db::lock_blocking` so poison recovery has exactly one definition (carryover fold: "collapse the two bounded-lock helpers").

- [ ] **Step 1: Write the failing test — a writer gets the lock while an ingest is running**

Append to `src-tauri/src/ingest.rs`'s `mod tests`:

```rust
    /// The whole point of chunking. Plan 3 writes user rows from commands, and the ingest
    /// used to hold `AppState.db` for its entire ~44 s run — so an "Add to collection"
    /// during the daily sync was a frozen button. Now the load commits every `BATCH` rows
    /// and drops the guard between batches, so the longest anyone waits is one batch.
    ///
    /// The probe runs on another thread, as a command would, and asks with a bound: if the
    /// ingest ever goes back to holding the connection throughout, this fails in seconds
    /// instead of hanging the suite.
    #[test]
    fn a_writer_gets_the_connection_between_batches_of_an_ingest() {
        let dir = std::env::temp_dir().join("mtgtest-ingest-chunked");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::migrate(&conn).unwrap();
        let db = std::sync::Mutex::new(conn);

        // Four batches' worth, so there are three release points to catch.
        let rows: Vec<String> = (0..BATCH * 4).map(card_line).collect();
        let lines: Vec<&str> = rows.iter().map(String::as_str).collect();
        let p = gz_fixture(&lines);

        let taken = std::sync::atomic::AtomicUsize::new(0);
        std::thread::scope(|scope| {
            scope.spawn(|| {
                // Runs for the length of the ingest, asking the way a command asks.
                while taken.load(std::sync::atomic::Ordering::SeqCst) < 3 {
                    if crate::db::lock_for(&db, std::time::Duration::from_millis(200)).is_some() {
                        taken.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    }
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            });
            let stats = ingest_gz(&db, &p, &mut |_| {}).unwrap();
            assert_eq!(stats.inserted, BATCH * 4);
        });

        assert!(
            taken.load(std::sync::atomic::Ordering::SeqCst) >= 3,
            "a writer must be able to take the connection while the ingest is running"
        );
        drop(db);
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run it and watch it fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml a_writer_gets_the_connection
```
Expected: a compile error — `ingest_gz` takes `&mut Connection`, not `&Mutex<Connection>`. That is the failure; the signature is the feature.

- [ ] **Step 3: Move poison recovery into `db.rs`** — add to `src-tauri/src/db.rs`, above `lock_for`:

```rust
/// How long a user-facing write waits for the write connection before answering "busy".
///
/// With the chunked ingest the longest anyone can be behind is one batch of 2 000 rows —
/// well under a second at the measured 2 600 rows/s. Five seconds is therefore not a
/// budget for a sync, it is the point at which something has genuinely gone wrong and the
/// honest answer is to say so rather than to hold a button down.
pub const WRITE_LOCK_WAIT: Duration = Duration::from_secs(5);

/// Take `mutex`, waiting as long as it takes.
///
/// Poisoning means some other thread panicked while holding the lock; the `Connection`
/// itself survives that (rusqlite rolls an open transaction back as it unwinds), so
/// refusing to lock ever again would brick every later sync and search for no gain.
///
/// This is the *one* definition of that rule — `sync::lock_conn`, `sync::lock_db` and
/// `sync::lock_db_read` all reach it, and [`lock_for`] applies the same recovery to the
/// bounded case.
pub fn lock_blocking(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
```

and in `src-tauri/src/sync.rs`, replace the body of `lock_conn`:

```rust
pub(crate) fn lock_conn(mutex: &Mutex<Connection>) -> MutexGuard<'_, Connection> {
    crate::db::lock_blocking(mutex)
}
```

- [ ] **Step 4: Chunk the staging load** — in `src-tauri/src/ingest.rs`, replace the whole of `ingest_gz` (and add the two helpers below it):

```rust
pub fn ingest_gz(
    db: &Mutex<Connection>,
    gz_path: &Path,
    progress: &mut dyn FnMut(u64),
) -> Result<IngestStats, IngestError> {
    // Opened before the database is touched: a missing or unreadable path must not
    // cost the caller the staging table it was about to fill.
    let file = std::fs::File::open(gz_path)?;
    {
        let conn = crate::db::lock_blocking(db);
        schema::create_staging(&conn)?;
    }
    let reader = BufReader::new(GzDecoder::new(file));
    let mut stats = IngestStats {
        inserted: 0,
        skipped: 0,
    };
    let mut batch: Vec<CardRow> = Vec::with_capacity(BATCH as usize);

    for line in reader.lines() {
        let line = line?;
        // Parsing happens with the lock *not* held — it is the expensive half of the
        // loop, and the whole point of chunking is that the connection is free during it.
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) else {
            stats.skipped += 1;
            continue;
        };
        let Some(row) = CardRow::from_json(&v) else {
            stats.skipped += 1;
            continue;
        };
        batch.push(row);
        if batch.len() as u64 >= BATCH {
            write_batch(db, &mut batch)?;
            stats.inserted += BATCH;
            progress(stats.inserted);
        }
    }
    if !batch.is_empty() {
        stats.inserted += batch.len() as u64;
        write_batch(db, &mut batch)?;
    }

    // Nothing parsed as a card: the download is bad, not the collection. Swapping
    // here would trade a working card database for an empty one, so refuse — and
    // drop the empty staging table rather than leave it lying around.
    if stats.inserted == 0 {
        let conn = crate::db::lock_blocking(db);
        conn.execute_batch("DROP TABLE IF EXISTS cards_staging")?;
        return Err(IngestError::Empty {
            skipped: stats.skipped,
        });
    }

    {
        let conn = crate::db::lock_blocking(db);
        schema::swap_staging(&conn)?;
    }
    progress(stats.inserted);
    Ok(stats)
}

/// Commit one batch of parsed rows into `cards_staging`, then let go of the connection.
///
/// One transaction per batch rather than one for the whole load. Staging is invisible to
/// readers until the swap either way, so the transaction is not what protects anyone —
/// it is a write-batching device, and the *release* between batches is the feature. A
/// crash partway leaves a partial `cards_staging`, which the next run drops before it
/// writes anything (see `create_staging`).
fn write_batch(db: &Mutex<Connection>, batch: &mut Vec<CardRow>) -> Result<(), IngestError> {
    let mut conn = crate::db::lock_blocking(db);
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare_cached(STAGING_INSERT)?;
        for c in batch.iter() {
            stmt.execute(params![
                c.id,
                c.oracle_id,
                c.name,
                c.lang,
                c.released_at,
                c.set_code,
                c.set_name,
                c.collector_number,
                c.rarity,
                c.layout,
                c.mana_cost,
                c.cmc,
                c.type_line,
                c.oracle_text,
                c.colors,
                c.color_identity,
                c.legalities,
                c.games,
                c.finishes,
                c.prices,
                c.price_usd,
                c.price_eur,
                c.faces,
                c.illustration_id,
                c.frame_effects,
                c.border_color,
                c.full_art,
                c.promo,
                c.promo_types,
                c.digital,
                c.is_paper,
                c.edhrec_rank,
                c.game_changer,
                c.image_status,
                c.image_updated_at,
                c.image_uris,
                c.face_image_uris,
                c.search_text,
                c.raw,
            ])?;
        }
    }
    tx.commit()?;
    batch.clear();
    Ok(())
}

/// The staging insert, named once. `prepare_cached` means the per-batch transaction does
/// not re-plan it 58 times over a full ingest.
const STAGING_INSERT: &str =
    "INSERT INTO cards_staging (id, oracle_id, name, lang, released_at, set_code, set_name,
        collector_number, rarity, layout, mana_cost, cmc, type_line, oracle_text, colors,
        color_identity, legalities, games, finishes, prices, price_usd, price_eur, faces,
        illustration_id, frame_effects, border_color, full_art, promo, promo_types, digital,
        is_paper, edhrec_rank, game_changer, image_status, image_updated_at, image_uris,
        face_image_uris, search_text, raw)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,
        ?23,?24,?25,?26,?27,?28,?29,?30,?31,?32,?33,?34,?35,?36,?37,?38,?39)";
```

`CardRow` does not carry `raw` yet — the ingest used to bind the line separately. Add the field in `src-tauri/src/card_row.rs`, after `search_text`:

```rust
    /// The original bulk line, stored verbatim so every field this schema does not model
    /// yet stays recoverable without a re-download. Owned by the row rather than passed
    /// beside it, because the batch that carries it to the database outlives the loop
    /// iteration that read it.
    pub raw: String,
```

and fill it in `from_json` — the function does not have the line, so take it as an argument:

```rust
    pub fn from_json(v: &Value) -> Option<CardRow> {
```
becomes
```rust
    /// `None` => skip line (not a card object). `raw` is the line the value was parsed
    /// from; `v.to_string()` is *not* the same thing (serde re-orders and re-formats), and
    /// the column's promise is verbatim.
    pub fn from_json_line(v: &Value, line: &str) -> Option<CardRow> {
```
with `raw: line.to_owned()` in the struct literal, plus a thin compatibility wrapper so the existing tests and the v2/ingest agreement test keep their call shape:

```rust
    /// The parse without a line to remember — used by tests and by anything that only
    /// wants the derived columns. `raw` is then the serialization of `v`.
    pub fn from_json(v: &Value) -> Option<CardRow> {
        CardRow::from_json_line(v, &v.to_string())
    }
```

and the ingest loop calls `CardRow::from_json_line(&v, &line)`.

- [ ] **Step 5: Update the two ingest tests the chunking genuinely changes**

In `io_failure_mid_stream_leaves_cards_intact_and_connection_usable`, the staging assertion moves from "rolled back" to "committed and irrelevant":

```rust
        let staged: i64 = conn
            .query_row("SELECT count(*) FROM cards_staging", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            staged, BATCH as i64,
            "the batches that committed before the read failed are still in staging — \
             which costs nothing, because staging is invisible until the swap and the next \
             run drops it before it writes a row"
        );
```

and both this test and `a_missing_file_fails_before_touching_staging` now build a `Mutex<Connection>` and read through it (`let conn = crate::db::lock_blocking(&db);`) rather than holding a `Connection` directly. Every other test in the module changes only its call: `ingest_gz(&db, &p, …)` where `let db = std::sync::Mutex::new(conn);`.

- [ ] **Step 6: Point `sync.rs` at the new signature** — in `do_sync`, the spawn_blocking closure becomes:

```rust
        tauri::async_runtime::spawn_blocking(move || {
            // No lock is taken here any more: the ingest takes it per batch and gives it
            // back, so a collection edit waits one batch rather than one sync.
            ingest::ingest_gz(&state.db, &gz, &mut |n| {
                emit(&app, "ingesting", n, INGEST_TOTAL_ESTIMATE)
            })
        })
```

- [ ] **Step 7: Run the ingest and sync suites**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml ingest
cargo test --manifest-path src-tauri/Cargo.toml sync
```
Expected: all green, including the new lock test and `progress_fires_every_batch_and_once_at_the_end` (unchanged: full batches report, the tail flush is silent, and the post-swap call is the last one).

- [ ] **Step 8: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: chunk the staging ingest so a sync no longer owns the write connection

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Schema v3 — the `artist` column and a gzipped `raw`

Carryover item 2a and 2b. `card.rs::ARTIST_SQL` is `raw`'s last runtime reader; once the column exists and the ingest fills it, `raw` is nothing but a local backfill archive — and an archive can be compressed. `raw` is 61% of a 1 021 MB live database, so gzip at ~4:1 is the single biggest disk win available.

**The compression is a write-path change, not a data migration.** `swap_staging` replaces every row on the next sync, so gzip-on-insert converts the whole corpus for free — no minutes-long one-time rewrite on a USB stick, no transient doubling of the file. The corpus is therefore uniformly TEXT until the first post-v3 sync and uniformly gzip after it.

**Files:**
- Modify: `src-tauri/src/schema.rs`, `src-tauri/src/card_row.rs`, `src-tauri/src/ingest.rs`, `src-tauri/src/card.rs`, `src-tauri/tests/fixtures/cards_sample.jsonl`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/schema.rs
/// The head schema version. `migrate` walks up to this.
pub const SCHEMA_VERSION: i64 = 3;

// src-tauri/src/card_row.rs
/// The bulk line as it is stored: gzip, because `raw` is two thirds of the database.
pub fn gzip_raw(line: &str) -> Vec<u8>;
/// The stored `raw` bytes as JSON text, whichever way they were written.
pub fn raw_json(stored: &[u8]) -> Option<String>;
```

- `CardRow.raw` changes from `String` to `Vec<u8>` (the gzip member), and `card.rs`'s `ARTIST_SQL` is deleted in favour of the plain `artist` column.

- [ ] **Step 1: Write the failing migration tests** — append to `src-tauri/src/schema.rs`'s `mod tests`:

```rust
    /// Carryover 2a: the artist gets a column of its own, backfilled out of the JSON that
    /// is already on disk. The face fallback is not decoration — a reversible card has no
    /// top-level artist at all, and the credit line Scryfall's image policy requires is
    /// rendered from this.
    #[test]
    fn the_v3_step_backfills_artist_out_of_raw_and_faces() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "top",
            "Lightning Bolt",
            r#"{"object":"card","artist":"Christopher Rush"}"#,
        );
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, faces, raw)
             VALUES ('rev','Reversible','sld','1','en','reversible_card',
                json_array(json_object('name','Front','artist','Nils Hamm')), '{\"object\":\"card\"}')",
            [],
        )
        .unwrap();
        insert_raw(&conn, "none", "No Credit", r#"{"object":"card"}"#);

        migrate(&conn).unwrap();

        let artist = |id: &str| -> Option<String> {
            conn.query_row("SELECT artist FROM cards WHERE id = ?1", [id], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(artist("top").as_deref(), Some("Christopher Rush"));
        assert_eq!(
            artist("rev").as_deref(),
            Some("Nils Hamm"),
            "a reversible card's credit is on its front face"
        );
        assert_eq!(artist("none"), None, "absent is absent, not empty");

        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
    }

    /// Same rule as v2: the step writes one new, unindexed column and renumbers no rowid,
    /// so it deliberately does not rebuild the FTS index — and this is the evidence that
    /// search still answers afterwards.
    #[test]
    fn the_v3_backfill_leaves_the_search_index_answering() {
        let conn = v1_database();
        insert_raw(
            &conn,
            "bolt",
            "Lightning Bolt",
            r#"{"object":"card","artist":"Christopher Rush"}"#,
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
        assert_eq!(hits, 1, "the FTS index must survive the v3 backfill");
    }

    /// The backfill reads `raw` as JSON, and from the first post-v3 sync `raw` is a gzip
    /// BLOB that `json_extract` answers with a hard `malformed JSON` error rather than a
    /// NULL. No database can be in that state when this step runs (a database with gzip
    /// rows is already past 3), but the guard is what makes that a fact rather than an
    /// argument — and it costs one `json_valid`.
    #[test]
    fn the_v3_backfill_steps_over_a_row_whose_raw_is_not_json() {
        let conn = v1_database();
        conn.execute(
            "INSERT INTO cards (id, name, set_code, collector_number, lang, layout, raw)
             VALUES ('gz','Compressed','tst','1','en','normal', ?1)",
            [crate::card_row::gzip_raw(r#"{"object":"card","artist":"Rebecca Guay"}"#)],
        )
        .unwrap();

        migrate(&conn).expect("a non-JSON `raw` must not fail the migration");

        let artist: Option<String> = conn
            .query_row("SELECT artist FROM cards WHERE id='gz'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(artist, None, "skipped, not guessed at");
    }

    /// A column added by a migration has to survive the sync that drops and recreates the
    /// table it is on — which it does only because `create_staging` derives its layout from
    /// the live table *and* the ingest writes the column. The second half is the one that
    /// fails silently: staging would clone the column and every row would come back NULL.
    #[test]
    fn the_artist_column_survives_a_staging_swap() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging
                (id, name, set_code, collector_number, lang, layout, raw, artist)
             VALUES ('new','Lightning Bolt','lea','161','en','normal','{}','Christopher Rush')",
            [],
        )
        .unwrap();
        swap_staging(&conn).unwrap();

        let artist: String = conn
            .query_row("SELECT artist FROM cards WHERE id='new'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(artist, "Christopher Rush");
    }
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml v3
```
Expected: `no such column: artist`, and `SCHEMA_VERSION` is not defined.

- [ ] **Step 3: Add the version constant and the v3 step** — in `src-tauri/src/schema.rs`, above `migrate`:

```rust
/// The head schema version — what [`migrate`] walks a database up to, and what
/// `migrate_is_idempotent_and_creates_tables` pins. Named because three tests and the
/// final `PRAGMA user_version` write all have to mean the same number.
pub const SCHEMA_VERSION: i64 = 3;
```

and inside `migrate`, after the `if v < 2` block:

```rust
    if v < 3 {
        let tx = conn.unchecked_transaction()?;
        // One nullable, unindexed column. No entry in `CARDS_INDEXES` (nothing here is
        // indexed), no edit to `CARDS_COLUMNS` (frozen), and no FTS rebuild — the index
        // covers name/type_line/search_text, none of which this touches, and an UPDATE
        // renumbers no rowid. `the_v3_backfill_leaves_the_search_index_answering` is the
        // evidence, exactly as v2's twin was.
        tx.execute_batch("ALTER TABLE cards ADD COLUMN artist TEXT;")?;

        // Read out of the JSON already on disk rather than re-downloading 77 MB. Two
        // sources because Scryfall has two: a reversible card carries no top-level artist,
        // only `card_faces[0].artist`.
        //
        // `json_valid` is the guard for a `raw` that is not JSON text. From the first
        // post-v3 sync `raw` is a gzip BLOB, and `json_extract` over one is a *hard error*
        // that would fail the whole migration — no database can be in that state when this
        // runs, and the guard is what keeps that true whatever a later step does.
        tx.execute_batch(
            "UPDATE cards
                SET artist = coalesce(
                        CASE WHEN json_valid(CAST(raw AS TEXT)) = 1
                             THEN json_extract(CAST(raw AS TEXT), '$.artist') END,
                        json_extract(faces, '$[0].artist'))
              WHERE artist IS NULL;",
        )?;

        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        tx.commit()?;
    }
```

Change the assertion in `migrate_is_idempotent_and_creates_tables` from `assert_eq!(version, 2)` to `assert_eq!(version, SCHEMA_VERSION)`, and the same in `migrate_reaches_version_2_and_adds_the_image_columns` (rename it to `migrate_reaches_the_head_version_and_adds_the_image_columns`).

- [ ] **Step 4: Add `artist` to the row and the compression helpers** — in `src-tauri/src/card_row.rs`, add the field after `face_image_uris`:

```rust
    /// Who drew it. A column of its own since v3: it is one short string per row, and
    /// reading it back out of `raw` on every card-detail query was the last thing keeping
    /// that blob in the hot path. Top level first, then the front face — a reversible card
    /// has no top-level artist.
    pub artist: Option<String>,
```

fill it in `from_json_line` with the existing `pick` helper (which is exactly this fallback):

```rust
            artist: pick("artist"),
```

change `raw` to the compressed bytes:

```rust
    /// The original bulk line, gzipped. `raw` is 61% of the database (622 MB of 1 021 MB
    /// measured live) and nothing reads it at runtime any more, so it is stored the way an
    /// archive is stored. Written into a column *declared* `TEXT NOT NULL` — SQLite's TEXT
    /// affinity leaves a BLOB a BLOB, so the storage class is honest even though the
    /// declaration is v1's and frozen.
    pub raw: Vec<u8>,
```
with `raw: gzip_raw(line),` in the struct literal, and add both helpers at module scope:

```rust
/// A bulk line, gzipped for storage.
///
/// `Compression::fast` rather than the default: level 1 runs at roughly ten times the
/// throughput of level 6 on this kind of text and gives up perhaps a tenth of the ratio,
/// and this runs 116 568 times inside a sync the user is watching. A compressor that
/// somehow fails hands back the plain bytes — [`raw_json`] reads both, so the fallback
/// costs disk rather than correctness.
pub fn gzip_raw(line: &str) -> Vec<u8> {
    use std::io::Write;
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    if enc.write_all(line.as_bytes()).is_err() {
        return line.as_bytes().to_vec();
    }
    enc.finish().unwrap_or_else(|_| line.as_bytes().to_vec())
}

/// The stored `raw` bytes as JSON text, whichever way they were written.
///
/// A gzip member always begins `1f 8b`; a Scryfall card line always begins `{`. That is
/// the whole discriminator, and it is what lets a database that has migrated to v3 but not
/// yet synced — every row still plain text — be read by the same code as one that has.
///
/// Read the column with `CAST(raw AS BLOB)`: rusqlite will not hand a TEXT value out as
/// `Vec<u8>`, and the cast is free for a value that is already a BLOB.
pub fn raw_json(stored: &[u8]) -> Option<String> {
    use std::io::Read;
    if stored.starts_with(&[0x1f, 0x8b]) {
        let mut out = String::new();
        flate2::read::GzDecoder::new(stored)
            .read_to_string(&mut out)
            .ok()?;
        return Some(out);
    }
    String::from_utf8(stored.to_vec()).ok()
}
```

- [ ] **Step 5: Add `artist` to the ingest** — in `src-tauri/src/ingest.rs`, add `artist` to `STAGING_INSERT`'s column list (after `face_image_uris`), bump the placeholder list to `?40`, and bind `c.artist` in the same position in `write_batch`.

- [ ] **Step 6: Retire `ARTIST_SQL`** — in `src-tauri/src/card.rs`, delete the constant and its doc comment, and replace both `{ARTIST_SQL}` interpolations with the bare column `artist`. Update the module doc's claim about `raw`:

```rust
//! Nothing here reads `raw`: `artist` has had a column of its own since schema v3, which
//! was the last thing this module took out of that blob.
```

- [ ] **Step 7: Write the storage-class test** — append to `src-tauri/src/card_row.rs`'s `mod tests`:

```rust
    /// The column is declared `TEXT NOT NULL` by a frozen v1 constant and now holds gzip.
    /// SQLite's TEXT affinity converts *numbers* to text and leaves a BLOB alone, so the
    /// storage class stays honest — and this is the test that says so, because the failure
    /// mode of the alternative (silent UTF-8 mangling of a compressed stream) is a `raw`
    /// column that no longer decompresses.
    #[test]
    fn raw_is_stored_as_a_blob_and_reads_back_byte_for_byte() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        let line = r#"{"object":"card","id":"x","name":"Lightning Bolt","lang":"en","layout":"normal","set":"lea","collector_number":"161","artist":"Christopher Rush"}"#;
        let row = CardRow::from_json_line(&serde_json::from_str(line).unwrap(), line).unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,artist,raw)
             VALUES (?1,?2,'lea','161','en','normal',?3,?4)",
            rusqlite::params![row.id, row.name, row.artist, row.raw],
        )
        .unwrap();

        let (kind, stored): (String, Vec<u8>) = conn
            .query_row(
                "SELECT typeof(raw), CAST(raw AS BLOB) FROM cards WHERE id='x'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(kind, "blob", "a gzip member must not be stored as text");
        assert_eq!(raw_json(&stored).as_deref(), Some(line), "verbatim, still");
        assert_eq!(row.artist.as_deref(), Some("Christopher Rush"));
        // Worth the ~4× it claims: the sample line is small, so this is the weak form of
        // the claim, and Task 14's smoke measures the real one.
        assert!(row.raw.len() < line.len(), "compressed, not merely wrapped");
    }

    /// A database that has migrated to v3 but has not synced yet holds plain-text `raw` in
    /// every row, and the same reader has to serve both.
    #[test]
    fn raw_json_reads_a_row_written_before_the_gzip_switch() {
        let line = r#"{"object":"card","name":"Lightning Bolt"}"#;
        assert_eq!(raw_json(line.as_bytes()).as_deref(), Some(line));
        assert_eq!(raw_json(&gzip_raw(line)).as_deref(), Some(line));
        assert_eq!(raw_json(&[0x1f, 0x8b, 0x00, 0x01]), None, "truncated gzip");
    }
```

- [ ] **Step 8: Fix the fixture and the column test** — `src-tauri/tests/fixtures/cards_sample.jsonl` lines gain an `"artist"` field (any real name), and in `ingest.rs`'s `every_column_receives_the_field_it_is_named_for`: add `"artist":"ARTIST"` to the `line` fixture, then **swap** two rows of the `expected` table — `("artist", Some("ARTIST"))` goes in, `("raw", Some(line))` comes out, so the array and its `[(&str, Option<&str>); 37]` annotation are unchanged. `raw` cannot stay in a table of text columns now that it is a gzip BLOB, so it gets its own check below:

```rust
        // `raw` is a gzip BLOB from v3, so it cannot be compared as a text column with the
        // rest. Decompressed it is still the verbatim line, which is the whole promise.
        let stored: Vec<u8> = conn
            .query_row("SELECT CAST(raw AS BLOB) FROM cards WHERE id='ID1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(crate::card_row::raw_json(&stored).as_deref(), Some(line));
```

- [ ] **Step 9: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: schema v3 - an artist column and a gzipped raw archive

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Database maintenance — `auto_vacuum` gets a home, and the swap gets its pages back

Carryover items 2c and 2d, and the decision the brief asks for out loud: **where does the one-time compaction run?**

It runs in a new `maintenance` module, at the tail of a successful sync, on the `sync:progress` channel as a `compacting` phase — *not* inside `migrate()`, which runs before the window exists and would be minutes of silence on a USB stick. It is attempted **once per database**: `PRAGMA auto_vacuum` is the flag, and a failure is recorded in `sync_meta.auto_vacuum_error` and never retried automatically (Plan 6's Settings button clears that key and calls the same function).

Most databases will never reach it, because of the ordering fact this task also fixes: **`auto_vacuum` must be set before `journal_mode=WAL` materialises the file.** Verified live while authoring — WAL first leaves a new database on `auto_vacuum = 0` no matter what the next statement says; auto_vacuum first gives `2`, and it survives every reopen. So a fresh install is incremental from its first byte, and only databases created by Plans 1–2 ever need the VACUUM.

**Files:**
- Create: `src-tauri/src/maintenance.rs`
- Modify: `src-tauri/src/db.rs`, `src-tauri/src/schema.rs`, `src-tauri/src/sync.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/useSyncProgress.ts`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/maintenance.rs
/// `sync_meta` key: why the one-time conversion failed, if it did.
pub const K_AUTO_VACUUM_ERROR: &str = "auto_vacuum_error";
/// Is this database still on SQLite's default `auto_vacuum = NONE`?
pub fn needs_conversion(conn: &Connection) -> bool;
/// Convert an existing database to incremental auto-vacuum. Minutes on a large file.
pub fn convert_to_incremental(conn: &Connection) -> rusqlite::Result<()>;
/// Hand freed pages back to the filesystem. Milliseconds; called after every swap.
pub fn incremental_vacuum(conn: &Connection) -> rusqlite::Result<()>;
```

- `schema::create_fts` becomes `pub` (mandatory after a VACUUM).
- `SyncPhase` gains `"compacting"` on both sides of the IPC boundary.

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/maintenance.rs` with the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("mtgtest-maint-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A database created the way Plans 1–2 created them: WAL first, so `auto_vacuum`
    /// never took. This is what every existing install looks like, and converting it is
    /// the whole reason this module exists.
    fn legacy_database(path: &std::path::Path) -> Connection {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "auto_vacuum", "INCREMENTAL").unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn
    }

    #[test]
    fn a_legacy_database_is_converted_once_and_keeps_its_search_index() {
        let dir = scratch("convert");
        let conn = legacy_database(&dir.join("mtg.db"));
        for i in 0..500 {
            conn.execute(
                "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,search_text,raw)
                 VALUES (?1,?2,'lea',?1,'en','normal',?2,'{}')",
                rusqlite::params![format!("c{i}"), format!("Lightning Bolt {i}")],
            )
            .unwrap();
        }
        conn.execute_batch("INSERT INTO cards_fts(cards_fts) VALUES('rebuild');")
            .unwrap();
        conn.execute("DELETE FROM cards WHERE CAST(substr(id,2) AS INTEGER) % 2 = 0", [])
            .unwrap();

        assert!(needs_conversion(&conn), "a legacy database starts at NONE");
        convert_to_incremental(&conn).unwrap();

        assert!(!needs_conversion(&conn), "and is incremental afterwards");
        let mode: String = conn
            .query_row("PRAGMA journal_mode", [], |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal", "the journal mode is not collateral");

        // The mandatory half. VACUUM may renumber the rowids an external-content FTS index
        // is keyed on (SQLite documents it for any table without an INTEGER PRIMARY KEY,
        // and `cards.id` is TEXT), and a desynced index returns the *wrong card* silently.
        let hits: i64 = conn
            .query_row(
                "SELECT count(*) FROM cards_fts WHERE cards_fts MATCH '\"lightning\"*'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(hits, 250, "the index counts the rows that are actually there");
        let joined: String = conn
            .query_row(
                "SELECT c.name FROM cards c JOIN cards_fts f ON f.rowid = c.rowid
                 WHERE cards_fts MATCH '\"lightning\"*' ORDER BY c.id LIMIT 1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert!(joined.starts_with("Lightning Bolt"), "{joined}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The cheap one, after every swap: freed pages go back to the filesystem instead of
    /// sitting in a freelist that measured 998 MB on the live database.
    #[test]
    fn incremental_vacuum_returns_freed_pages() {
        let dir = scratch("incremental");
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        conn.execute_batch("CREATE TABLE t (v TEXT);").unwrap();
        let tx = conn.unchecked_transaction().unwrap();
        for i in 0..5000 {
            tx.execute("INSERT INTO t VALUES (?1)", [format!("{i}{}", "x".repeat(200))])
                .unwrap();
        }
        tx.commit().unwrap();
        conn.execute("DELETE FROM t", []).unwrap();
        let before: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();

        incremental_vacuum(&conn).unwrap();

        let after: i64 = conn
            .query_row("PRAGMA freelist_count", [], |r| r.get(0))
            .unwrap();
        assert!(before > 0, "the deletes should have freed pages");
        assert_eq!(after, 0, "and this is what hands them back");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A database this app creates is incremental from its first byte — which is only true
    /// because `db::open` sets the pragma *before* `journal_mode=WAL` writes the header.
    /// Measured live: with WAL first, a new file reads back `auto_vacuum = 0` and stays
    /// there through every reopen.
    #[test]
    fn a_database_this_app_creates_never_needs_converting() {
        let dir = scratch("fresh");
        let conn = crate::db::open(&dir.join("mtg.db")).unwrap();
        crate::schema::migrate(&conn).unwrap();

        assert!(!needs_conversion(&conn));

        drop(conn);
        let reopened = crate::db::open(&dir.join("mtg.db")).unwrap();
        assert!(!needs_conversion(&reopened), "and it stays that way");
        drop(reopened);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml maintenance
```
Expected: the module has no `needs_conversion`/`convert_to_incremental`/`incremental_vacuum`, and `db.rs` still sets WAL first.

- [ ] **Step 3: Write the module** — the rest of `src-tauri/src/maintenance.rs`:

```rust
//! Database maintenance: the one-time `auto_vacuum` conversion, and the cheap page return
//! after every sync.
//!
//! Deliberately **not** part of `schema::migrate`. `migrate` runs before the window
//! exists, and a `VACUUM` on the measured 2.02 GB live database rewrites the whole file —
//! minutes of an unresponsive splash on the USB stick this app is meant to run from.
//! Compaction is therefore an *operation*, with a phase on the sync progress channel, and
//! it happens after the sync it follows rather than before the app the user launched.

use rusqlite::Connection;

/// `sync_meta` key holding why the one-time conversion failed, if it ever did.
///
/// Its presence is also the "do not try again" flag. A `VACUUM` needs free space roughly
/// the size of the database, so the common failure is a full disk — retrying that on every
/// sync would spend a minute a day achieving nothing. Plan 6's "Compact database" button
/// is what clears the key and asks again, deliberately, with the user watching.
pub const K_AUTO_VACUUM_ERROR: &str = "auto_vacuum_error";

/// Is this database still on SQLite's default `auto_vacuum = NONE`?
///
/// `2` is incremental. A database this app created is already there (see [`crate::db::open`]);
/// one created by Plan 1 or Plan 2 is not, because the pragma was issued after
/// `journal_mode=WAL` had already materialised the file, where it is silently a no-op.
pub fn needs_conversion(conn: &Connection) -> bool {
    conn.query_row("PRAGMA auto_vacuum", [], |r| r.get::<_, i64>(0))
        .map(|mode| mode != 2)
        .unwrap_or(false)
}

/// Convert an existing database to `auto_vacuum = INCREMENTAL`.
///
/// Three statements, and the order is the whole of it:
///
/// 1. the pragma, which by itself only records an intention;
/// 2. `VACUUM`, which is what applies it — and which rewrites every page of the file;
/// 3. `create_fts`, **mandatory**: SQLite documents that `VACUUM` may renumber the ROWIDs
///    of any table without an INTEGER PRIMARY KEY, `cards.id` is TEXT, and `cards_fts` is
///    external-content with no triggers. A desynced external-content index does not error
///    — it returns the wrong card, quietly, for the life of the database.
///
/// Then a truncating checkpoint, because the VACUUM has just written the entire database
/// through the write-ahead log and leaving that on disk would undo most of what it bought.
pub fn convert_to_incremental(conn: &Connection) -> rusqlite::Result<()> {
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.execute_batch("VACUUM;")?;
    crate::schema::create_fts(conn)?;
    crate::db::checkpoint_truncate(conn)
}

/// Hand pages freed since the last call back to the filesystem.
///
/// Measured at 33 ms on a scale model of the live database, and it needs no temporary file
/// — which is what makes it safe to run inside a sync. The swap frees an entire copy of
/// `cards` every time; without this the file only ever grows (measured: 922 MB → 2.02 GB
/// over two forced re-syncs).
pub fn incremental_vacuum(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA incremental_vacuum;")
}
```

Register the module in `src-tauri/src/lib.rs` (`pub mod maintenance;`, alphabetically after `images`).

- [ ] **Step 4: Fix the pragma order in `db::open`** — in `src-tauri/src/db.rs`:

```rust
pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    // FIRST, before any statement writes a page. On a database that does not exist yet
    // this is free and permanent; once `journal_mode=WAL` has materialised the file it is
    // a no-op that only a full `VACUUM` can apply (measured live while planning: WAL
    // first leaves a brand-new database on `auto_vacuum = 0` through every reopen).
    // Incremental rather than full: the return of freed pages is then something the app
    // asks for after a swap, not something SQLite pays for on every commit.
    conn.pragma_update(None, "auto_vacuum", "INCREMENTAL")?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "journal_size_limit", JOURNAL_SIZE_LIMIT)?;
    conn.busy_timeout(BUSY_TIMEOUT)?;
    Ok(conn)
}
```

and extend `open_sets_wal` with:

```rust
        let auto_vacuum: i64 = conn
            .query_row("PRAGMA auto_vacuum", [], |r| r.get(0))
            .unwrap();
        assert_eq!(auto_vacuum, 2, "auto_vacuum must be INCREMENTAL (2)");
```

- [ ] **Step 5: Make `create_fts` public** — in `src-tauri/src/schema.rs`, change `fn create_fts` to `pub fn create_fts` and extend its doc:

```rust
/// (Re)create the external-content FTS5 index over `cards` and populate it.
///
/// `search_text` is the haystack column: ingest concatenates oracle text plus every
/// face's name and text into it.
///
/// Public because `VACUUM` needs it. Anything that renumbers `cards`' rowids leaves this
/// index pointing at the wrong rows, and the failure is silent — see
/// [`crate::maintenance::convert_to_incremental`], which calls this unconditionally.
```

- [ ] **Step 6: Wire it into the sync** — in `src-tauri/src/sync.rs`, add the phase to the `Progress` doc list (`checking | downloading | ingesting | sets | compacting | done | error`), then, inside `do_sync`, immediately after the ingest's `spawn_blocking` result is unwrapped and the temp file removed:

```rust
    {
        // The swap has just freed an entire copy of `cards`. Returning those pages costs
        // milliseconds and is the difference between a file that plateaus and one that
        // grows by ~550 MB per refresh.
        let conn = lock_db(state);
        if let Err(e) = crate::maintenance::incremental_vacuum(&conn) {
            eprintln!("could not return freed pages after the swap: {e}");
        }
    }
```

and in **both** places a run reaches `mark_checked` — the tail of `do_sync` (the path that ingested) and `finish_unchanged` (the path that found nothing new) — after that call and before `emit_done`:

```rust
    compact_once(state, app).await;
```

Both, because the ETag makes 304 the *common* answer: a legacy database whose owner syncs daily and always gets "already up to date" would otherwise never reach a compaction that is only ever going to run once.

with, at module scope:

```rust
/// Convert this database to incremental auto-vacuum, once, ever.
///
/// Runs here rather than in `migrate` because it is minutes of work on a large file and
/// `migrate` runs before there is a window to say so in. Runs *after* the sync rather than
/// before it because a sync is the one moment the user has already been told the app is
/// busy with the database — and because compacting a file that is about to be rewritten
/// would be work done twice.
///
/// A failure is recorded and never retried automatically: `VACUUM` needs free space about
/// the size of the database, so the common failure is a disk that will still be full
/// tomorrow. Plan 6's "Compact database" control is what clears the key and asks again.
async fn compact_once(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let due = {
        let conn = lock_db_read(state);
        crate::maintenance::needs_conversion(&conn)
            && get_meta(&conn, crate::maintenance::K_AUTO_VACUUM_ERROR).is_none()
    };
    if !due {
        return;
    }
    emit(app, "compacting", 0, 0);
    let state = state.clone();
    let joined = tauri::async_runtime::spawn_blocking(move || {
        let conn = lock_db(&state);
        let result = crate::maintenance::convert_to_incremental(&conn);
        if let Err(e) = &result {
            let _ = set_meta(
                &conn,
                crate::maintenance::K_AUTO_VACUUM_ERROR,
                &e.to_string(),
            );
        }
        result
    })
    .await;
    match joined {
        Ok(Ok(())) => {}
        // Neither failure is the sync's failure: the cards are ingested and stored either
        // way, and a database that did not compact is a database that works.
        Ok(Err(e)) => eprintln!("database compaction failed: {e}"),
        Err(e) => eprintln!("database compaction task failed: {e}"),
    }
}
```

- [ ] **Step 7: Teach the frontend the new phase** — in `src/lib/ipc.ts`:

```ts
export type SyncPhase =
  | "checking"
  | "downloading"
  | "ingesting"
  | "sets"
  | "compacting"
  | "done"
  | "error";
```

and in `src/lib/useSyncProgress.ts`, add to `PHASE_LABEL`:

```ts
  // Once per database, ever: the one-time conversion to incremental auto-vacuum. It rides
  // the mana line like every other phase, with no denominator — `VACUUM` reports no
  // progress of any kind, so claiming a fraction would be an invention.
  compacting: "Compacting database…",
```

- [ ] **Step 8: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: database maintenance - incremental auto-vacuum and post-swap page return

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Schema v4 — `collection_entries`, `wishlist_entries`, `card_migrations`

Spec §6's grain, in SQL. Everything about these tables is shaped by one invariant: **`cards` is dropped and recreated on every sync**, so nothing here may declare a foreign key to it, and every row has to stay identifiable when the id it points at stops resolving.

**Files:**
- Modify: `src-tauri/src/schema.rs`

**Interfaces:**
- Produces:

```rust
/// The columns that make two collection rows *the same row*, as one SQL fragment.
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, '')";
/// The same for the wishlist: an oracle card, optionally pinned to one printing.
pub const WISHLIST_GRAIN: &str =
    "coalesce(oracle_id, ''), coalesce(card_id, ''), coalesce(preferred_finish, '')";
```

- `SCHEMA_VERSION` becomes `4`.

- [ ] **Step 1: Write the failing tests** — append to `src-tauri/src/schema.rs`'s `mod tests`:

```rust
    /// The invariant this whole plan is shaped by, now with the real tables: a sync drops
    /// `cards` outright, and the user's collection has to be sitting there afterwards.
    /// `foreign_keys` is ON here (as it is in `db::open`) so the failure this guards
    /// against — a `REFERENCES cards(id)` that aborts every sync — could actually happen.
    #[test]
    fn user_rows_survive_the_swap_that_drops_cards() {
        let conn = Connection::open_in_memory().unwrap();
        conn.pragma_update(None, "foreign_keys", "ON").unwrap();
        migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','lea','161','en','normal','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('bolt','lea','161','en','foil','LP',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1',NULL,'Lightning Bolt',2,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO card_migrations (id,performed_at,strategy,old_card_id,new_card_id,applied_at)
             VALUES ('m1','2026-01-01T00:00:00Z','merge','old','bolt',unixepoch())",
            [],
        )
        .unwrap();

        create_staging(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards_staging (id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('bolt','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        swap_staging(&conn).expect("a sync must not be blocked by the user's own tables");

        for table in ["collection_entries", "wishlist_entries", "card_migrations"] {
            let n: i64 = conn
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(n, 1, "`{table}` is not sync data");
        }
        // And the denormalised printing is still the printing the user recorded, not
        // whatever the new `cards` row says. That is the point of storing it.
        let (set, cn): (String, String) = conn
            .query_row(
                "SELECT set_code, collector_number FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!((set.as_str(), cn.as_str()), ("lea", "161"));
    }

    /// Two copies are one row when they agree on the grain, and two rows when they do not.
    /// The `coalesce`s are load-bearing: SQLite treats NULLs in a UNIQUE index as distinct,
    /// so without them a second unserialised copy would insert instead of conflicting, and
    /// the upsert every quick-add depends on would silently create duplicates.
    #[test]
    fn the_collection_grain_is_unique_including_the_nullable_parts() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let add = |finish: &str, condition: &str, serial: Option<&str>| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,
                     serial_number,created_at,updated_at)
                 VALUES ('bolt','lea','161','en',?1,?2,1,?3,unixepoch(),unixepoch())",
                rusqlite::params![finish, condition, serial],
            )
        };
        add("foil", "NM", None).unwrap();
        assert!(add("foil", "NM", None).is_err(), "same grain, same row");
        add("nonfoil", "NM", None).unwrap();
        add("foil", "LP", None).unwrap();
        add("foil", "NM", Some("042/500")).unwrap();
        add("foil", "NM", Some("043/500")).unwrap();

        let n: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 5);
    }

    /// The enums, enforced where they cannot be argued with. `finishes` is a strict enum
    /// upstream and the research doc names a boolean `foil` column as the single most
    /// common importer data-loss bug; a CHECK is what stops "Foil" or `1` ever landing.
    #[test]
    fn the_finish_and_condition_enums_are_enforced_by_the_database() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let add = |finish: &str, condition: &str, qty: i64| {
            conn.execute(
                "INSERT INTO collection_entries
                    (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
                 VALUES ('bolt','lea','161','en',?1,?2,?3,unixepoch(),unixepoch())",
                rusqlite::params![finish, condition, qty],
            )
        };
        for (finish, condition, qty) in [
            ("Foil", "NM", 1),
            ("foil", "Near Mint", 1),
            ("foil", "NM", -1),
            ("", "NM", 1),
        ] {
            assert!(
                add(finish, condition, qty).is_err(),
                "({finish}, {condition}, {qty}) must not be storable"
            );
        }
        for finish in ["nonfoil", "foil", "etched"] {
            add(finish, "NM", 1).unwrap();
        }
        for condition in ["NM", "LP", "MP", "HP", "DMG"] {
            add("nonfoil", condition, 1).unwrap();
        }
    }

    /// A wish is for an *oracle card*, optionally pinned to a printing — and "any
    /// printing" (`card_id IS NULL`) is a different wish from "this printing", not a
    /// duplicate of it.
    #[test]
    fn a_wish_for_any_printing_and_one_for_a_printing_are_two_rows() {
        let conn = Connection::open_in_memory().unwrap();
        migrate(&conn).unwrap();
        let wish = |card_id: Option<&str>, finish: Option<&str>| {
            conn.execute(
                "INSERT INTO wishlist_entries
                    (oracle_id,card_id,name,quantity,preferred_finish,created_at,updated_at)
                 VALUES ('o1',?1,'Lightning Bolt',1,?2,unixepoch(),unixepoch())",
                rusqlite::params![card_id, finish],
            )
        };
        wish(None, None).unwrap();
        assert!(wish(None, None).is_err(), "the same wish twice is one wish");
        wish(Some("bolt-lea"), None).unwrap();
        wish(None, Some("foil")).unwrap();

        let n: i64 = conn
            .query_row("SELECT count(*) FROM wishlist_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(n, 3);
    }
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib schema
```
Expected: `no such table: collection_entries`.

- [ ] **Step 3: Add the grain constants and the v4 step** — in `src-tauri/src/schema.rs`, bump `SCHEMA_VERSION` to `4`, add above `migrate`:

```rust
/// What makes two collection rows the *same* row, as one SQL fragment.
///
/// Written once because it is used twice and the two uses must agree exactly: the UNIQUE
/// index that enforces the grain, and the `ON CONFLICT(…)` target of every quick-add. A
/// conflict target that does not match an index verbatim is not a compile error, it is a
/// runtime "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
///
/// The `coalesce`s are the reason this is not just a column list. SQLite treats NULLs in a
/// UNIQUE index as *distinct*, so a nullable column in the grain is a column that stops
/// enforcing anything the moment it is empty — which for `serial_number` (NULL on every
/// card that is not serialized, i.e. nearly all of them) would mean no grain at all.
pub const COLLECTION_GRAIN: &str = "card_id, finish, condition, lang, altered, signed, proxy, \
     misprint, coalesce(serial_number, ''), coalesce(grading, '')";

/// The wishlist's grain: an oracle card, optionally pinned to one printing and one finish.
/// `card_id IS NULL` means "any printing" (spec §6), which is a different wish from a
/// specific one rather than a looser version of it.
pub const WISHLIST_GRAIN: &str =
    "coalesce(oracle_id, ''), coalesce(card_id, ''), coalesce(preferred_finish, '')";
```

and the step itself, after the `if v < 3` block:

```rust
    if v < 4 {
        let tx = conn.unchecked_transaction()?;
        // Spec §6, and every column here answers to the same invariant: `cards` is
        // dropped and recreated on every sync, so `card_id` carries **no** `REFERENCES`
        // clause and the printing is denormalised beside it. A declared foreign key would
        // abort every sync; `ON DELETE CASCADE` would delete the user's collection on the
        // next refresh. Orphans are flagged (`needs_review`), never deleted.
        //
        // None of these tables is `cards`, so `CARDS_INDEXES` is not involved: their
        // indexes are created here and nothing drops them.
        tx.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS collection_entries (
                id INTEGER PRIMARY KEY,
                -- Soft reference. No REFERENCES clause, deliberately and permanently.
                card_id TEXT NOT NULL,
                -- Migration insurance: what the user actually owns, in the terms printed
                -- on the card, still readable when the id stops resolving.
                set_code TEXT NOT NULL,
                collector_number TEXT NOT NULL,
                lang TEXT NOT NULL DEFAULT 'en',
                -- Enum, never a boolean: `etched` is a third thing, and collapsing it is
                -- the most common importer data-loss bug there is.
                finish TEXT NOT NULL CHECK (finish IN ('nonfoil','foil','etched')),
                condition TEXT NOT NULL DEFAULT 'NM'
                    CHECK (condition IN ('NM','LP','MP','HP','DMG')),
                -- What the import said before it was normalised. Kept because the
                -- normalisation is lossy (EU 'GD' and NA 'MP' arrive as one grade) and the
                -- user's own file is the only place the difference still exists.
                condition_original TEXT,
                quantity INTEGER NOT NULL CHECK (quantity >= 0),
                tradelist_quantity INTEGER NOT NULL DEFAULT 0
                    CHECK (tradelist_quantity >= 0),
                purchase_price REAL,
                purchase_currency TEXT,
                acquired_at TEXT,
                -- No competitor stores this. It is one TEXT column and it is the answer to
                -- 'where did I get this?', which is the question a collection is actually
                -- asked years later.
                acquisition_source TEXT,
                -- 042/500. Not in Scryfall's data at all — user-supplied, and part of the
                -- grain, because two serialized copies are two different objects.
                serial_number TEXT,
                altered INTEGER NOT NULL DEFAULT 0,
                signed INTEGER NOT NULL DEFAULT 0,
                proxy INTEGER NOT NULL DEFAULT 0,
                misprint INTEGER NOT NULL DEFAULT 0,
                -- {{company, grade, cert}}. JSON because the shape differs per grader
                -- (CGC has two grades numbered 10; PSA has no 9.5) and a column per
                -- grader is a migration per grader.
                grading TEXT CHECK (grading IS NULL OR json_valid(grading)),
                tags TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tags)),
                notes TEXT,
                -- NULL is the normal state. A sentence here means the row needs the user's
                -- attention — the printing vanished from Scryfall, or a merge landed it
                -- somewhere this database cannot see. Never a reason to delete the row.
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_grain
                ON collection_entries ({grain});
             CREATE INDEX IF NOT EXISTS idx_collection_card
                ON collection_entries (card_id);
             CREATE INDEX IF NOT EXISTS idx_collection_review
                ON collection_entries (needs_review) WHERE needs_review IS NOT NULL;

             CREATE TABLE IF NOT EXISTS wishlist_entries (
                id INTEGER PRIMARY KEY,
                -- The oracle card. NULLABLE, because reversible cards genuinely have no
                -- oracle_id and a wish for one can only be a wish for its printing.
                oracle_id TEXT,
                -- NULL = any printing (spec §6). Set = that printing and no other.
                card_id TEXT,
                set_code TEXT,
                collector_number TEXT,
                lang TEXT,
                -- Denormalised here but not in the collection, on purpose: an any-printing
                -- wish has no card row to join for a name, and a shopping list that cannot
                -- say what it is shopping for is not a list.
                name TEXT NOT NULL,
                quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
                preferred_finish TEXT
                    CHECK (preferred_finish IS NULL
                           OR preferred_finish IN ('nonfoil','foil','etched')),
                notes TEXT,
                needs_review TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                -- A wish that names neither an oracle card nor a printing is a wish for
                -- nothing, and would collide with every other such row on the grain.
                CHECK (oracle_id IS NOT NULL OR card_id IS NOT NULL)
             );
             CREATE UNIQUE INDEX IF NOT EXISTS idx_wishlist_grain
                ON wishlist_entries ({wish});
             CREATE INDEX IF NOT EXISTS idx_wishlist_card ON wishlist_entries (card_id);
             CREATE INDEX IF NOT EXISTS idx_wishlist_oracle ON wishlist_entries (oracle_id);

             -- Every Scryfall id migration this database has already applied, so a re-poll
             -- is a no-op instead of a second repoint. Scryfall's own id is the key.
             CREATE TABLE IF NOT EXISTS card_migrations (
                id TEXT PRIMARY KEY,
                performed_at TEXT,
                strategy TEXT NOT NULL CHECK (strategy IN ('merge','delete')),
                old_card_id TEXT NOT NULL,
                new_card_id TEXT,
                note TEXT,
                applied_at INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS idx_card_migrations_old
                ON card_migrations (old_card_id);",
            grain = COLLECTION_GRAIN,
            wish = WISHLIST_GRAIN
        ))?;
        tx.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;
        tx.commit()?;
    }
```

Note the `{{company, grade, cert}}` escaping — the SQL is inside `format!`, so a literal brace is doubled. The two `{grain}`/`{wish}` interpolations are the named arguments below the string.

- [ ] **Step 4: Extend the table-count assertion** — in `migrate_is_idempotent_and_creates_tables`, widen the `IN (…)` list to `('cards','sets','sync_meta','cards_fts','collection_entries','wishlist_entries','card_migrations')` and assert `7`.

- [ ] **Step 5: Run the schema suite**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib schema
```
Expected: all green, including the four new tests.

- [ ] **Step 6: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: schema v4 - collection, wishlist and card-migration tables

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Collection CRUD — add, adjust, remove

The write half of spec §7. One upsert carries the whole quick-add flow: adding a card you already own at the same finish and condition adds to the row you have, which is what "grain" means.

Every command here takes the **write** connection, with a bound — `db::lock_for(&state.db, WRITE_LOCK_WAIT)`. After Task 1 the longest that can block is one ingest batch, so the bound is a truth-telling device rather than a workaround: if it expires, something is genuinely wrong and the honest answer is a sentence, not a frozen button.

**Files:**
- Create: `src-tauri/src/collection.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `crate::db::{lock_for, WRITE_LOCK_WAIT}`, `crate::sync::{lock_db_read, AppState}`, `crate::schema::COLLECTION_GRAIN`.
- Produces:

```rust
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];
pub const CONDITIONS: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];
pub const DEFAULT_CONDITION: &str = "NM";
pub const BUSY: &str = "The card database is busy finishing a sync. Try that again in a moment.";

pub struct EntryInput { /* camelCase on the wire; see below */ }
pub struct EntryChange { pub id: i64, pub quantity: i64, pub removed: bool }

pub fn add_entry(conn: &Connection, input: &EntryInput) -> Result<EntryChange, String>;
pub fn set_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String>;
pub fn update_entry(conn: &Connection, id: i64, input: &EntryPatch) -> Result<EntryChange, String>;
pub fn remove_entry(conn: &Connection, id: i64) -> Result<EntryChange, String>;

#[tauri::command] pub async fn collection_add(…) -> Result<EntryChange, String>;
#[tauri::command] pub async fn collection_set_quantity(…) -> Result<EntryChange, String>;
#[tauri::command] pub async fn collection_update(…) -> Result<EntryChange, String>;
#[tauri::command] pub async fn collection_remove(…) -> Result<EntryChange, String>;
```

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/collection.rs` with its test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('bolt-lea','o1','Lightning Bolt','lea','161','en','normal','common',
                '[\"nonfoil\"]',
                '{\"usd\":\"400.50\",\"usd_foil\":null,\"eur\":\"320.00\"}','{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                rarity,finishes,prices,raw)
             VALUES ('bolt-jp','o1','Lightning Bolt','4ed','209','ja','normal','common',
                '[\"nonfoil\",\"foil\"]','{\"usd\":\"12.00\",\"usd_foil\":\"90.00\"}','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn input(card_id: &str, finish: &str, quantity: i64) -> EntryInput {
        EntryInput {
            card_id: card_id.to_owned(),
            finish: finish.to_owned(),
            quantity,
            ..Default::default()
        }
    }

    /// The whole quick-add contract: the same printing, finish and condition twice is one
    /// row with a bigger number, not two rows a collection view would show side by side.
    #[test]
    fn adding_the_same_printing_twice_adds_to_the_row_that_is_already_there() {
        let conn = seeded();

        let first = add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        let second = add_entry(&conn, &input("bolt-lea", "nonfoil", 3)).unwrap();

        assert_eq!(first.id, second.id, "the same grain is the same row");
        assert_eq!(second.quantity, 5);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1);
    }

    /// The printing is denormalised *at write time*, from `cards` — which is the only
    /// moment it is knowable. After the next sync drops and rebuilds that table, this row
    /// is still a Japanese Fourth Edition Lightning Bolt whatever happens to the id.
    #[test]
    fn an_entry_records_the_printing_it_was_made_from() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let (set, cn, lang): (String, String, String) = conn
            .query_row(
                "SELECT set_code, collector_number, lang FROM collection_entries",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!((set.as_str(), cn.as_str(), lang.as_str()), ("4ed", "209", "ja"));
    }

    /// Different finish, different condition, different flags, different serial: four
    /// different physical things, four rows. This is the grain in the language a user
    /// would use for it.
    #[test]
    fn copies_that_differ_in_the_grain_are_separate_rows() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();
        add_entry(
            &conn,
            &EntryInput {
                condition: Some("LP".into()),
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();
        add_entry(
            &conn,
            &EntryInput {
                signed: true,
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();
        add_entry(
            &conn,
            &EntryInput {
                serial_number: Some("042/500".into()),
                ..input("bolt-jp", "foil", 1)
            },
        )
        .unwrap();

        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 5);
    }

    /// The enum, refused in words rather than as a constraint violation the UI would have
    /// to translate. `"Foil"` is what an import writes and what a boolean would have
    /// flattened; it is not a finish.
    #[test]
    fn an_unknown_finish_or_condition_is_refused_with_a_sentence() {
        let conn = seeded();
        let bad_finish = add_entry(
            &conn,
            &EntryInput {
                finish: "Foil".into(),
                ..input("bolt-lea", "foil", 1)
            },
        )
        .unwrap_err();
        assert!(bad_finish.contains("nonfoil"), "{bad_finish}");

        let bad_condition = add_entry(
            &conn,
            &EntryInput {
                condition: Some("Near Mint".into()),
                ..input("bolt-lea", "nonfoil", 1)
            },
        )
        .unwrap_err();
        assert!(bad_condition.contains("NM"), "{bad_condition}");
    }

    /// An id with no card behind it is a bug in the caller, not a card nobody has heard
    /// of: every add starts from a printing the user is looking at.
    #[test]
    fn adding_an_unknown_card_id_is_an_error_not_an_empty_row() {
        let conn = seeded();
        let err = add_entry(&conn, &input("no-such-card", "nonfoil", 1)).unwrap_err();
        assert!(err.contains("no card"), "{err}");
    }

    /// Zero is not a quantity, it is a removal — and the stepper in the collection table
    /// is the only thing that ever sends it. A row of zero copies would sit in the list
    /// forever answering "none".
    #[test]
    fn setting_a_quantity_to_zero_removes_the_row() {
        let conn = seeded();
        let added = add_entry(&conn, &input("bolt-lea", "nonfoil", 3)).unwrap();

        let lowered = set_quantity(&conn, added.id, 1).unwrap();
        assert_eq!((lowered.quantity, lowered.removed), (1, false));

        let gone = set_quantity(&conn, added.id, 0).unwrap();
        assert!(gone.removed);
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 0);
    }

    /// Editing a row onto a grain that already exists is the one edit that cannot just be
    /// applied. Answering with the constraint name would be the database talking; this is
    /// the app talking, and it names the way out.
    #[test]
    fn editing_a_row_onto_an_existing_grain_says_what_to_do_instead() {
        let conn = seeded();
        let nonfoil = add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let err = update_entry(
            &conn,
            nonfoil.id,
            &EntryPatch {
                finish: Some("foil".into()),
                ..Default::default()
            },
        )
        .unwrap_err();
        assert!(err.contains("already have"), "{err}");
    }

    /// `src/lib/ipc.ts` mirrors this by hand and nothing checks that the two still agree.
    #[test]
    fn entry_change_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(EntryChange {
            id: 7,
            quantity: 3,
            removed: false,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({"id": 7, "quantity": 3, "removed": false})
        );
    }

    /// `invoke` matches argument names, and the payload the popup sends omits every field
    /// it has no value for — so every one of them has to have a default.
    #[test]
    fn a_partial_camel_case_payload_deserialises_into_a_usable_entry() {
        let input: EntryInput =
            serde_json::from_str(r#"{"cardId":"bolt-lea","finish":"foil","quantity":2}"#).unwrap();
        assert_eq!(input.card_id, "bolt-lea");
        assert_eq!(input.condition, None, "absent means the default, NM");
        assert!(!input.altered && !input.signed && !input.proxy && !input.misprint);

        let conn = seeded();
        let change = add_entry(&conn, &input).unwrap();
        let condition: String = conn
            .query_row("SELECT condition FROM collection_entries WHERE id = ?1", [change.id], |r| r.get(0))
            .unwrap();
        assert_eq!(condition, DEFAULT_CONDITION);
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml collection
```
Expected: the module does not exist yet.

- [ ] **Step 3: Write the module** — the rest of `src-tauri/src/collection.rs`:

```rust
//! The owned-cards table: what the user has, at what grain, and what it is worth.
//!
//! Shaped like [`crate::card`]: pure functions over a `Connection`, testable without a
//! Tauri app, wrapped in `async` commands that run on the blocking pool. The difference is
//! which connection — these *write*, so they take `AppState.db` with a bound rather than
//! `db_read`, and a lock they cannot get is an answer rather than a wait.

use crate::schema::COLLECTION_GRAIN;
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// Scryfall's finish enum. Never a boolean — `etched` is a third thing, and collapsing it
/// into `foil: true` is the single most common way an importer loses data.
pub const FINISHES: [&str; 3] = ["nonfoil", "foil", "etched"];

/// The NA condition scale, in descending order. The EU scale (`M/NM/EX/GD/LP/PL/PO`) is
/// normalised into this one at the edge — see `src/features/collection/conditions.ts` —
/// and the string it arrived as is kept in `condition_original`.
pub const CONDITIONS: [&str; 5] = ["NM", "LP", "MP", "HP", "DMG"];

/// What a card is assumed to be when nobody says otherwise.
pub const DEFAULT_CONDITION: &str = "NM";

/// What a write command says when it could not have the database.
///
/// A sentence rather than a lock error, and it names the wait: after the ingest was
/// chunked (Task 1) the only thing that can hold the connection for five seconds is
/// something genuinely stuck, and "try again in a moment" is both true and actionable.
pub const BUSY: &str = "The card database is busy finishing a sync. Try that again in a moment.";

/// One quick-add, as the UI sends it.
///
/// `#[serde(default)]` throughout: the popup sends the three fields it has (`cardId`,
/// `finish`, `quantity`) and the entry editor sends more. `lang`, `set_code` and
/// `collector_number` are deliberately *not* here — they are properties of the printing,
/// read from `cards` at write time, and letting a caller supply them would let a caller
/// disagree with the card it named.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryInput {
    pub card_id: String,
    pub finish: String,
    pub condition: Option<String>,
    pub condition_original: Option<String>,
    pub quantity: i64,
    pub tradelist_quantity: i64,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: bool,
    pub signed: bool,
    pub proxy: bool,
    pub misprint: bool,
    /// `{"company":"PSA","grade":"9","cert":"12345678"}`, verbatim JSON.
    pub grading: Option<String>,
    /// A JSON array of strings. `None` means the row keeps whatever it has.
    pub tags: Option<String>,
    pub notes: Option<String>,
}

/// An edit to one existing row. Every field is optional: absent means "leave it".
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct EntryPatch {
    pub finish: Option<String>,
    pub condition: Option<String>,
    pub quantity: Option<i64>,
    pub tradelist_quantity: Option<i64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: Option<bool>,
    pub signed: Option<bool>,
    pub proxy: Option<bool>,
    pub misprint: Option<bool>,
    pub grading: Option<String>,
    pub tags: Option<String>,
    pub notes: Option<String>,
}

/// What a write did. `removed` is the difference between "you now have zero" and "that row
/// is gone", which the list has to know to drop it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryChange {
    pub id: i64,
    pub quantity: i64,
    pub removed: bool,
}

fn valid_finish(finish: &str) -> Result<&str, String> {
    FINISHES
        .contains(&finish)
        .then_some(finish)
        .ok_or_else(|| format!("`{finish}` is not a finish. Use one of: {}.", FINISHES.join(", ")))
}

fn valid_condition(condition: Option<&str>) -> Result<&str, String> {
    let c = condition.unwrap_or(DEFAULT_CONDITION);
    CONDITIONS
        .contains(&c)
        .then_some(c)
        .ok_or_else(|| format!("`{c}` is not a condition. Use one of: {}.", CONDITIONS.join(", ")))
}

/// The printing, as the entry will remember it.
fn printing_of(conn: &Connection, card_id: &str) -> Result<(String, String, String), String> {
    conn.query_row(
        "SELECT set_code, collector_number, lang FROM cards WHERE id = ?1",
        params![card_id],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    )
    .optional()
    .map_err(|e| e.to_string())?
    .ok_or_else(|| format!("no card with the id `{card_id}` is in the card database"))
}

/// Add copies, folding into the row that already holds this grain.
pub fn add_entry(conn: &Connection, input: &EntryInput) -> Result<EntryChange, String> {
    let finish = valid_finish(&input.finish)?;
    let condition = valid_condition(input.condition.as_deref())?;
    if input.quantity <= 0 {
        return Err("Adding a card needs a quantity of at least one.".into());
    }
    let (set_code, collector_number, lang) = printing_of(conn, &input.card_id)?;

    // The conflict target is `COLLECTION_GRAIN` verbatim — the same text the unique index
    // was created from. Anything else is a runtime "ON CONFLICT clause does not match any
    // PRIMARY KEY or UNIQUE constraint", which is why the fragment is a constant.
    //
    // The quantities add; everything else is a first-writer-wins detail. A second add of a
    // card you already own is the user saying "one more of these", not "and here is what I
    // paid for it this time" — so a purchase price, a source or a note already on the row
    // stays, and one supplied for a row that has none is taken.
    let sql = format!(
        "INSERT INTO collection_entries
            (card_id, set_code, collector_number, lang, finish, condition, condition_original,
             quantity, tradelist_quantity, purchase_price, purchase_currency, acquired_at,
             acquisition_source, serial_number, altered, signed, proxy, misprint, grading,
             tags, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,
                 coalesce(?20,'[]'),?21, unixepoch(), unixepoch())
         ON CONFLICT({COLLECTION_GRAIN}) DO UPDATE SET
            quantity = collection_entries.quantity + excluded.quantity,
            tradelist_quantity =
                collection_entries.tradelist_quantity + excluded.tradelist_quantity,
            purchase_price = coalesce(collection_entries.purchase_price, excluded.purchase_price),
            purchase_currency =
                coalesce(collection_entries.purchase_currency, excluded.purchase_currency),
            acquired_at = coalesce(collection_entries.acquired_at, excluded.acquired_at),
            acquisition_source =
                coalesce(collection_entries.acquisition_source, excluded.acquisition_source),
            notes = coalesce(collection_entries.notes, excluded.notes),
            updated_at = unixepoch()
         RETURNING id, quantity"
    );
    let (id, quantity): (i64, i64) = conn
        .query_row(
            &sql,
            params![
                input.card_id,
                set_code,
                collector_number,
                lang,
                finish,
                condition,
                input.condition_original,
                input.quantity,
                input.tradelist_quantity,
                input.purchase_price,
                input.purchase_currency,
                input.acquired_at,
                input.acquisition_source,
                input.serial_number,
                input.altered,
                input.signed,
                input.proxy,
                input.misprint,
                input.grading,
                input.tags,
                input.notes,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(friendly)?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Set an absolute quantity. Zero removes the row: a row of no cards is not a fact about a
/// collection, it is a row nobody deleted.
pub fn set_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String> {
    if quantity <= 0 {
        return remove_entry(conn, id);
    }
    let changed = conn
        .execute(
            "UPDATE collection_entries
                SET quantity = ?2,
                    -- A tradelist bigger than the pile it is drawn from is not a promise
                    -- anyone can keep.
                    tradelist_quantity = min(tradelist_quantity, ?2),
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(friendly)?;
    if changed == 0 {
        return Err("That collection entry is not there any more.".into());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

/// Apply an edit. Absent fields are left alone (`coalesce(?n, column)`), which is what
/// makes this usable from a form that only sends what it changed.
pub fn update_entry(conn: &Connection, id: i64, patch: &EntryPatch) -> Result<EntryChange, String> {
    if let Some(f) = patch.finish.as_deref() {
        valid_finish(f)?;
    }
    if let Some(c) = patch.condition.as_deref() {
        valid_condition(Some(c))?;
    }
    if patch.quantity == Some(0) {
        return remove_entry(conn, id);
    }
    let quantity: i64 = conn
        .query_row(
            "UPDATE collection_entries SET
                finish = coalesce(?2, finish),
                condition = coalesce(?3, condition),
                quantity = coalesce(?4, quantity),
                tradelist_quantity = min(coalesce(?5, tradelist_quantity),
                                         coalesce(?4, quantity)),
                purchase_price = coalesce(?6, purchase_price),
                purchase_currency = coalesce(?7, purchase_currency),
                acquired_at = coalesce(?8, acquired_at),
                acquisition_source = coalesce(?9, acquisition_source),
                serial_number = coalesce(?10, serial_number),
                altered = coalesce(?11, altered),
                signed = coalesce(?12, signed),
                proxy = coalesce(?13, proxy),
                misprint = coalesce(?14, misprint),
                grading = coalesce(?15, grading),
                tags = coalesce(?16, tags),
                notes = coalesce(?17, notes),
                updated_at = unixepoch()
             WHERE id = ?1
             RETURNING quantity",
            params![
                id,
                patch.finish,
                patch.condition,
                patch.quantity,
                patch.tradelist_quantity,
                patch.purchase_price,
                patch.purchase_currency,
                patch.acquired_at,
                patch.acquisition_source,
                patch.serial_number,
                patch.altered,
                patch.signed,
                patch.proxy,
                patch.misprint,
                patch.grading,
                patch.tags,
                patch.notes,
            ],
            |r| r.get(0),
        )
        .optional()
        .map_err(friendly)?
        .ok_or_else(|| "That collection entry is not there any more.".to_owned())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

pub fn remove_entry(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM collection_entries WHERE id = ?1", params![id])
        .map_err(friendly)?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

/// A database error in the app's own voice.
///
/// Only one of them is a user's problem rather than a bug: an edit that lands on a grain
/// the collection already holds. SQLite says "UNIQUE constraint failed:
/// index 'idx_collection_grain'", which names an implementation detail and no way forward.
fn friendly(e: rusqlite::Error) -> String {
    let text = e.to_string();
    if text.contains("idx_collection_grain") {
        return "You already have an entry for that printing at that finish and condition — \
                change its quantity instead, or give this one a different condition."
            .to_owned();
    }
    text
}

/// Run `f` with the write connection, or answer [`BUSY`].
///
/// Bounded rather than blocking: this runs on a worker thread from a button press, and the
/// one thing that can hold `AppState.db` for any length of time is a sync — which, since
/// the ingest was chunked, holds it for one batch at a time.
fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(BUSY.to_owned()),
    }
}

#[tauri::command]
pub async fn collection_add(
    state: tauri::State<'_, Arc<AppState>>,
    entry: EntryInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_entry(c, &entry)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| set_quantity(c, id, quantity)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_update(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    patch: EntryPatch,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| update_entry(c, id, &patch)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}

#[tauri::command]
pub async fn collection_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_entry(c, id)))
        .await
        .map_err(|e| format!("the collection could not be written: {e}"))?
}
```

- [ ] **Step 4: Register the module and the commands** — in `src-tauri/src/lib.rs`, add `pub mod collection;` (alphabetically, before `db`) and extend `generate_handler!`:

```rust
            collection::collection_add,
            collection::collection_set_quantity,
            collection::collection_update,
            collection::collection_remove,
```

- [ ] **Step 5: Run the suite and verify**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml collection
npm run verify
```

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: collection entries - add, adjust and remove at the spec grain

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Collection list and summary — shared card filters, natural sort, per-finish value

The read half, and the one place a price is turned into money. Three things land here:

1. **`filters.rs`** — the card predicates (format, colours, sets, mana values, rarity, paper) lifted out of `search.rs` so the collection list filters cards the same way the search does, with the same tests behind it. The extraction is proved by `search.rs`'s existing suite staying green untouched.
2. **Natural collector-number sort** — the carryover fold, landing where it was always going to be needed.
3. **Per-finish valuation from the `prices` blob.** Never `price_usd`. EUR has no `eur_etched` in the data, so an etched copy is *unpriced* in EUR rather than priced at the nonfoil rate.

**Files:**
- Create: `src-tauri/src/filters.rs`
- Modify: `src-tauri/src/search.rs`, `src-tauri/src/collection.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/filters.rs
pub const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];
pub const MAX_SET_FILTER: usize = 64;
pub const MANA_VALUE_OPEN_ENDED: u8 = 8;
pub struct CardFilters { text, format, colors, set_code, sets, mana_values, rarity, paper_only }
#[derive(Default)] pub struct Predicates {
    pub wheres: Vec<String>,
    pub params: Vec<Box<dyn rusqlite::ToSql>>,
}
impl Predicates { pub fn where_sql(&self) -> String; }
/// The FTS5 MATCH string for a user's text, or `None` when nothing indexable is left.
pub fn fts_query(text: &str) -> Option<String>;
/// Push every non-text card predicate onto `p`, qualified with `alias`.
pub fn push_card_filters(p: &mut Predicates, f: &CardFilters, alias: &str);

// src-tauri/src/collection.rs
pub const FINISH_PRICE_USD: &str;   // the CASE that reads `prices` by finish
pub const FINISH_PRICE_EUR: &str;
pub struct CollectionQuery { cards: CardFilters (flattened), finishes, conditions, needsReview, sort, limit, offset }
pub struct CollectionRow { … }
pub struct CollectionPage { pub items: Vec<CollectionRow>, pub total: i64 }
pub struct CollectionSummary { … }
pub fn list_entries(conn: &Connection, q: &CollectionQuery) -> Result<CollectionPage, String>;
pub fn summarise(conn: &Connection, q: &CollectionQuery) -> Result<CollectionSummary, String>;
#[tauri::command] pub async fn collection_list(…) -> Result<CollectionPage, String>;
#[tauri::command] pub async fn collection_summary(…) -> Result<CollectionSummary, String>;
```

- [ ] **Step 1: Write the failing tests** — append to `src-tauri/src/collection.rs`'s `mod tests`:

```rust
    /// Money, per finish, out of the blob. The fixture is built so that using `price_usd`
    /// — the derived fallback chain — instead would give a *different, higher* number:
    /// the Alpha printing has no foil price at all, and `price_usd` would fall through to
    /// the nonfoil one and quietly value a foil that does not exist at $400.
    #[test]
    fn value_is_summed_per_finish_from_the_prices_blob() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap(); // 2 × 400.50
        add_entry(&conn, &input("bolt-jp", "foil", 3)).unwrap(); //     3 × 90.00
        add_entry(&conn, &input("bolt-jp", "nonfoil", 1)).unwrap(); //  1 × 12.00

        let s = summarise(&conn, &CollectionQuery::default()).unwrap();

        assert_eq!(s.total_cards, 6);
        assert_eq!(s.unique_cards, 2, "two printings, three rows");
        assert_eq!(s.entries, 3);
        assert!(
            (s.value_usd - (2.0 * 400.50 + 3.0 * 90.00 + 12.00)).abs() < 0.005,
            "got {}",
            s.value_usd
        );
        // The Japanese printing has no EUR price of any kind, so those four cards are
        // counted as unpriced rather than valued at their dollar figure.
        assert!((s.value_eur - 2.0 * 320.00).abs() < 0.005, "got {}", s.value_eur);
        assert_eq!(s.unpriced_eur, 4);
        assert_eq!(s.unpriced_usd, 0);
    }

    /// `eur_etched` is documented and **does not exist in the data**. An etched card is
    /// therefore unpriced in euros — never priced at the nonfoil rate, which is what a
    /// naive `coalesce` chain would do.
    #[test]
    fn an_etched_card_has_no_euro_price_at_all() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                finishes,prices,raw)
             VALUES ('bolt-etch','o1','Lightning Bolt','sld','1','en','normal',
                '[\"etched\"]','{\"usd\":\"5.00\",\"usd_etched\":\"25.00\",\"eur\":\"4.00\"}','{}')",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-etch", "etched", 2)).unwrap();

        let s = summarise(&conn, &CollectionQuery::default()).unwrap();

        assert!((s.value_usd - 50.00).abs() < 0.005, "got {}", s.value_usd);
        assert_eq!(s.value_eur, 0.0, "there is no eur_etched key in the data");
        assert_eq!(s.unpriced_eur, 2);
    }

    /// Collector numbers are TEXT and ~9% of them are not numeric. A plain string sort puts
    /// `100` before `2`; this is the sort a printed binder is in.
    #[test]
    fn the_set_sort_orders_collector_numbers_naturally() {
        let conn = seeded();
        for (id, cn) in [
            ("c-100", "100"),
            ("c-2", "2"),
            ("c-9", "9"),
            ("c-741z", "741z"),
            ("c-star", "1★"),
            ("c-a", "A-123"),
        ] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
                 VALUES (?1,'o9','Filler','tst',?2,'en','normal','{}')",
                rusqlite::params![id, cn],
            )
            .unwrap();
            add_entry(&conn, &input(id, "nonfoil", 1)).unwrap();
        }

        let page = list_entries(
            &conn,
            &CollectionQuery {
                sort: Some("set".into()),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let numbers: Vec<&str> = page
            .items
            .iter()
            .filter(|r| r.set_code == "tst")
            .map(|r| r.collector_number.as_str())
            .collect();
        assert_eq!(numbers, ["A-123", "1★", "2", "9", "100", "741z"]);
    }

    /// The card filters are the *same* filters the search view uses — that is what
    /// `filters.rs` is for — and the entry filters AND with them.
    #[test]
    fn the_card_filters_and_the_entry_filters_combine() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 1)).unwrap();
        add_entry(&conn, &input("bolt-jp", "foil", 1)).unwrap();

        let by_set = list_entries(
            &conn,
            &CollectionQuery {
                cards: crate::filters::CardFilters {
                    sets: Some(vec!["lea".into()]),
                    ..Default::default()
                },
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(by_set.total, 1);
        assert_eq!(by_set.items[0].set_code, "lea");

        let foils = list_entries(
            &conn,
            &CollectionQuery {
                finishes: Some(vec!["foil".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(foils.total, 1);
        assert_eq!(foils.items[0].finish, "foil");

        let neither = list_entries(
            &conn,
            &CollectionQuery {
                cards: crate::filters::CardFilters {
                    sets: Some(vec!["lea".into()]),
                    ..Default::default()
                },
                finishes: Some(vec!["foil".into()]),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(neither.total, 0, "the filters AND, they do not OR");
    }

    /// A row whose printing has left the card database still lists, still counts, and
    /// still says which card it is — from the columns denormalised at write time. This is
    /// the payoff for spec §6's insurance, and the reason the join is a LEFT JOIN.
    #[test]
    fn an_orphaned_entry_still_lists_with_its_denormalised_printing() {
        let conn = seeded();
        add_entry(&conn, &input("bolt-lea", "nonfoil", 2)).unwrap();
        conn.execute("DELETE FROM cards WHERE id = 'bolt-lea'", []).unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();

        assert_eq!(page.total, 1);
        let row = &page.items[0];
        assert_eq!(row.name, None, "there is no card row to name it");
        assert_eq!((row.set_code.as_str(), row.collector_number.as_str()), ("lea", "161"));
        assert_eq!(row.unit_price_usd, None, "and no price either — not zero");
        let s = summarise(&conn, &CollectionQuery::default()).unwrap();
        assert_eq!(s.total_cards, 2, "the cards are still owned");
        assert_eq!(s.unpriced_usd, 2);
    }

    /// The digital-printing rule the search applies does **not** apply here: the user owns
    /// what the user owns, and a paper-only predicate over a LEFT JOIN would also delete
    /// every orphan from the list, because `NULL = 1` is not true.
    #[test]
    fn the_collection_does_not_hide_rows_behind_the_paper_only_default() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                is_paper,digital,raw)
             VALUES ('bolt-mtgo','o1','Lightning Bolt','pmtg1','7','en','normal',0,1,'{}')",
            [],
        )
        .unwrap();
        add_entry(&conn, &input("bolt-mtgo", "nonfoil", 1)).unwrap();

        let page = list_entries(
            &conn,
            &CollectionQuery {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(page.total, 1);
    }

    /// The hand-mirrored wire contract, pinned whole so a field added on this side and
    /// never mirrored in `src/lib/ipc.ts` fails here rather than rendering as `undefined`.
    #[test]
    fn collection_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(CollectionRow {
            id: 7,
            card_id: "bolt-lea".into(),
            name: Some("Lightning Bolt".into()),
            set_code: "lea".into(),
            set_name: Some("Limited Edition Alpha".into()),
            collector_number: "161".into(),
            lang: "en".into(),
            rarity: Some("common".into()),
            mana_cost: Some("{R}".into()),
            type_line: Some("Instant".into()),
            layout: Some("normal".into()),
            finish: "nonfoil".into(),
            condition: "NM".into(),
            quantity: 4,
            tradelist_quantity: 1,
            unit_price_usd: Some(400.5),
            unit_price_eur: Some(320.0),
            purchase_price: Some(12.5),
            purchase_currency: Some("USD".into()),
            acquired_at: Some("2020-05-01".into()),
            acquisition_source: Some("Local shop".into()),
            serial_number: None,
            altered: false,
            signed: true,
            proxy: false,
            misprint: false,
            grading: None,
            tags: "[]".into(),
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
        })
        .unwrap();

        assert_eq!(
            value,
            serde_json::json!({
                "id": 7, "cardId": "bolt-lea", "name": "Lightning Bolt", "setCode": "lea",
                "setName": "Limited Edition Alpha", "collectorNumber": "161", "lang": "en",
                "rarity": "common", "manaCost": "{R}", "typeLine": "Instant", "layout": "normal",
                "finish": "nonfoil", "condition": "NM", "quantity": 4, "tradelistQuantity": 1,
                "unitPriceUsd": 400.5, "unitPriceEur": 320.0, "purchasePrice": 12.5,
                "purchaseCurrency": "USD", "acquiredAt": "2020-05-01",
                "acquisitionSource": "Local shop", "serialNumber": null, "altered": false,
                "signed": true, "proxy": false, "misprint": false, "grading": null,
                "tags": "[]", "notes": null, "needsReview": null, "updatedAt": 1800000000
            })
        );

        let summary = serde_json::to_value(CollectionSummary {
            total_cards: 6,
            unique_cards: 2,
            entries: 3,
            tradelist_cards: 1,
            value_usd: 1213.0,
            value_eur: 640.0,
            unpriced_usd: 0,
            unpriced_eur: 4,
            needs_review: 0,
        })
        .unwrap();
        assert_eq!(
            summary,
            serde_json::json!({
                "totalCards": 6, "uniqueCards": 2, "entries": 3, "tradelistCards": 1,
                "valueUsd": 1213.0, "valueEur": 640.0, "unpricedUsd": 0, "unpricedEur": 4,
                "needsReview": 0
            })
        );
    }
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml collection
```

- [ ] **Step 3: Extract the shared filters** — create `src-tauri/src/filters.rs`:

```rust
//! The card predicates, in one place, so every list that filters cards filters them the
//! same way.
//!
//! Lifted out of [`crate::search`] when the collection needed the same six filters over a
//! *joined* query. Everything here is alias-parameterised (`c` in the search, `c` in the
//! collection's LEFT JOIN) and pushes its parameters in the order it pushes its SQL, which
//! is the invariant the whole builder rests on: `?` binds by position, so a fragment and
//! its parameter must never be separated.
//!
//! Only two kinds of thing are ever interpolated into the SQL — a colour letter from
//! [`COLORS`] and a `?`-placeholder list whose *length* is all it carries. No user text
//! reaches the parser.

use serde::Deserialize;

/// The five colour-identity letters, in WUBRG order. Interpolated into SQL, so it must
/// stay a hard-coded list.
pub const COLORS: [&str; 5] = ["W", "U", "B", "R", "G"];

/// Sets one request will filter on. The picker is a multi-select over ~1 050 sets; past a
/// few dozen the filter has stopped narrowing anything.
pub const MAX_SET_FILTER: usize = 64;

/// The last mana-value chip is open-ended: "8" means 8 *or more*.
pub const MANA_VALUE_OPEN_ENDED: u8 = 8;

/// Every filter that is a statement about a *card*, as the UI sends it.
#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CardFilters {
    /// Free text, prefix-matched through FTS5. Handled by the caller, because the join it
    /// needs is the caller's to make — see [`fts_query`].
    pub text: Option<String>,
    pub format: Option<String>,
    pub colors: Option<String>,
    pub set_code: Option<String>,
    pub sets: Option<Vec<String>>,
    pub mana_values: Option<Vec<u8>>,
    pub rarity: Option<String>,
    /// Omitted means true in the search and false in the collection: a search offers cards
    /// to own, a collection lists cards that are owned.
    pub paper_only: Option<bool>,
}

/// SQL fragments and the parameters they bound, in push order.
#[derive(Default)]
pub struct Predicates {
    pub wheres: Vec<String>,
    pub params: Vec<Box<dyn rusqlite::ToSql>>,
}

impl Predicates {
    /// The `WHERE` body. `1=1` rather than an empty string so callers can always write
    /// `WHERE {}` without a branch.
    pub fn where_sql(&self) -> String {
        if self.wheres.is_empty() {
            "1=1".to_owned()
        } else {
            self.wheres.join(" AND ")
        }
    }

    pub fn push(&mut self, sql: String, param: Box<dyn rusqlite::ToSql>) {
        self.wheres.push(sql);
        self.params.push(param);
    }
}

/// The FTS5 `MATCH` string for a user's text, or `None` when nothing indexable is left.
///
/// FTS5 has its own query language: `"`, `*`, `:`, `(`, `AND`/`OR`/`NOT` and `NEAR` are all
/// operators, and a stray one is a syntax *error*, not a zero-result search. Splitting on
/// everything non-alphanumeric leaves tokens that cannot contain an operator by
/// construction; quoting each makes it a literal phrase, and the trailing `*` is the one
/// operator kept, for prefix matching.
///
/// Splitting, not stripping: the index is built by `unicode61`, which breaks on the same
/// boundaries. Deleting punctuation inside a word would weld its halves into a token
/// nothing indexes — `Ajani's` → `ajanis`, `God-Pharaoh` → `godpharaoh`.
pub fn fts_query(text: &str) -> Option<String> {
    let toks: Vec<String> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{t}\"*"))
        .collect();
    (!toks.is_empty()).then(|| toks.join(" "))
}

/// Push every non-text card predicate onto `p`, qualified with `alias`.
pub fn push_card_filters(p: &mut Predicates, f: &CardFilters, alias: &str) {
    // `restricted` counts as playable — a Vintage search that hid Black Lotus would be
    // wrong. Formats the card has no entry for yield NULL, which fails the IN.
    if let Some(v) = nonblank(&f.format) {
        p.push(
            format!("json_extract({alias}.legalities, '$.' || ?) IN ('legal','restricted')"),
            Box::new(v.to_owned()),
        );
    }

    // Subset semantics, as in a deckbuilder: show what this identity can *cast*, so "RW"
    // returns mono-R, mono-W, RW — and colourless, which fits in any deck. Expressed as
    // exclusions so the number of clauses stays fixed and each one is a plain `instr`.
    if let Some(colors) = nonblank(&f.colors) {
        let colors = colors.to_ascii_uppercase();
        if colors == "C" {
            p.wheres.push(format!(
                "({alias}.color_identity = '' OR {alias}.color_identity IS NULL)"
            ));
        } else {
            for ch in COLORS {
                if !colors.contains(ch) {
                    p.wheres.push(format!(
                        "instr(coalesce({alias}.color_identity,''), '{ch}') = 0"
                    ));
                }
            }
        }
    }

    if let Some(s) = nonblank(&f.set_code) {
        p.push(format!("{alias}.set_code = ?"), Box::new(s.to_owned()));
    }

    // OR within, AND without. Blank entries are dropped rather than matched: a picker's
    // cleared state sends `[]`, and some send `[""]`.
    if let Some(sets) = f.sets.as_deref() {
        let mut picked: Vec<String> = sets
            .iter()
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .collect();
        picked.sort();
        picked.dedup();
        picked.truncate(MAX_SET_FILTER);
        if !picked.is_empty() {
            let holes = vec!["?"; picked.len()].join(",");
            p.wheres.push(format!("{alias}.set_code IN ({holes})"));
            for code in picked {
                p.params.push(Box::new(code));
            }
        }
    }

    // Discrete chips, not a range: 0–7 are exact and 8 is open-ended. `cmc` is REAL and
    // nullable — a fractional un-card cost matches no chip, and a card with no cost at all
    // matches none either, because `NULL IN (…)` and `NULL >= 8` are both NULL.
    //
    // Deduplicated first: a payload that repeats a chip would otherwise generate a
    // placeholder per repeat, which is a longer statement for the same answer (carryover
    // fold: "manaValues dedupe").
    if let Some(values) = f.mana_values.as_deref() {
        let mut exact: Vec<f64> = Vec::new();
        let mut open_ended = false;
        let mut seen: Vec<u8> = Vec::new();
        for v in values {
            if seen.contains(v) {
                continue;
            }
            seen.push(*v);
            if *v >= MANA_VALUE_OPEN_ENDED {
                open_ended = true;
            } else {
                exact.push(f64::from(*v));
            }
        }
        let mut alternatives: Vec<String> = Vec::new();
        if !exact.is_empty() {
            let holes = vec!["?"; exact.len()].join(",");
            alternatives.push(format!("{alias}.cmc IN ({holes})"));
            for v in exact {
                p.params.push(Box::new(v));
            }
        }
        if open_ended {
            alternatives.push(format!("{alias}.cmc >= {MANA_VALUE_OPEN_ENDED}.0"));
        }
        if !alternatives.is_empty() {
            p.wheres.push(format!("({})", alternatives.join(" OR ")));
        }
    }

    if let Some(r) = nonblank(&f.rarity) {
        p.push(format!("{alias}.rarity = ?"), Box::new(r.to_owned()));
    }
    if f.paper_only.unwrap_or(true) {
        p.wheres.push(format!("{alias}.is_paper = 1"));
    }
}

/// A filter the user actually set: trimmed, and `None` when blank.
///
/// A UI whose "Any set"/"Any format" option carries an empty value sends `Some("")`. Taken
/// literally that would mean `set_code = ''` (matches nothing) or the json path `'$.'` —
/// which is a *SQLite error*, failing the whole query rather than one filter.
pub fn nonblank(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}
```

Register it in `lib.rs` (`pub mod filters;`).

- [ ] **Step 4: Point `search.rs` at it** — replace the filter-building block of `run_search` (everything from `let mut wheres` down to the `paper_only` clause) with:

```rust
    let mut p = filters::Predicates::default();
    // Joined only when there is something to match, because the join is also what makes
    // `bm25(cards_fts, …)` legal: naming an FTS table's auxiliary function in a query that
    // does not read that table is a *prepare* error, not a bad ranking.
    let mut from_sql = "cards c";
    let mut ranked = false;
    if let Some(text) = filters::nonblank(&req.text) {
        // All-punctuation input leaves nothing to match on. Dropping the clause searches
        // everything, which is what an empty search box does anyway.
        if let Some(query) = filters::fts_query(text) {
            from_sql = "cards c JOIN cards_fts ON cards_fts.rowid = c.rowid";
            p.push("cards_fts MATCH ?".to_owned(), Box::new(query));
            ranked = true;
        }
    }
    filters::push_card_filters(&mut p, &req.card_filters(), "c");
    let where_sql = p.where_sql();
    let mut params = p.params;
```

and add an `impl SearchRequest` block beside the struct:

```rust
    /// The card half of this request, in the shape every other list uses.
    ///
    /// Cloned rather than borrowed, and the fields stay flat on this struct rather than
    /// moving behind a `#[serde(flatten)]`: the wire shape is what `src/lib/ipc.ts` sends
    /// and thirty tests construct, and a request is a handful of small strings.
    fn card_filters(&self) -> filters::CardFilters {
        filters::CardFilters {
            text: None, // handled above, with the join it needs
            format: self.format.clone(),
            colors: self.colors.clone(),
            set_code: self.set_code.clone(),
            sets: self.sets.clone(),
            mana_values: self.mana_values.clone(),
            rarity: self.rarity.clone(),
            paper_only: self.paper_only,
        }
    }
```

Delete `search.rs`'s now-duplicate `COLORS`, `MAX_SET_FILTER`, `MANA_VALUE_OPEN_ENDED` and `nonblank`, and re-point the two references in `SearchRequest`'s doc comments at `filters::MANA_VALUE_OPEN_ENDED`. **`search.rs`'s test module is not edited at all** — it passing untouched is the proof that the extraction changed nothing.

- [ ] **Step 5: Write the list and summary** — append to `src-tauri/src/collection.rs`:

```rust
/// What one owned card is worth in USD, read from the `prices` blob **by finish**.
///
/// Never `cards.price_usd`: that column is a display/sort fallback chain
/// (`usd → usd_foil → usd_etched`) and would price a plain copy of a card whose only
/// listed price is its foil at the foil's price. A finish with no price is `NULL` —
/// which is a different statement from `0.00`, and is counted as such.
pub const FINISH_PRICE_USD: &str = "CAST(json_extract(c.prices,
        CASE e.finish WHEN 'foil' THEN '$.usd_foil'
                      WHEN 'etched' THEN '$.usd_etched'
                      ELSE '$.usd' END) AS REAL)";

/// The same in EUR, with the hole the data actually has: **`eur_etched` does not exist**.
/// An etched card is unpriced in euros rather than valued at the nonfoil rate.
pub const FINISH_PRICE_EUR: &str = "CASE e.finish WHEN 'etched' THEN NULL ELSE
        CAST(json_extract(c.prices,
            CASE e.finish WHEN 'foil' THEN '$.eur_foil' ELSE '$.eur' END) AS REAL) END";

/// Rows per page. The collection is not 116 k rows, but it can be tens of thousands, and
/// the table is virtualised for the same reason the search results are.
const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// A collection list, as the UI asks for it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CollectionQuery {
    /// The card filters, flattened onto the same JSON object — so `{"sets":["lea"],
    /// "finishes":["foil"]}` is one payload rather than a nested shape the UI has to build.
    #[serde(flatten)]
    pub cards: crate::filters::CardFilters,
    pub finishes: Option<Vec<String>>,
    pub conditions: Option<Vec<String>>,
    /// `Some(true)` narrows to the rows a Scryfall migration or a vanished printing flagged.
    pub needs_review: Option<bool>,
    /// `"name"` (default) | `"set"` | `"added"` | `"quantity"` | `"price"`.
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

/// One row of the collection table: the entry, plus whatever `cards` still knows about the
/// printing it names. Every `cards`-derived field is `Option` — a row whose printing has
/// left the database is still a card the user owns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionRow {
    pub id: i64,
    pub card_id: String,
    pub name: Option<String>,
    /// From the *entry*, not the card: this is what the user recorded owning.
    pub set_code: String,
    pub set_name: Option<String>,
    pub collector_number: String,
    pub lang: String,
    pub rarity: Option<String>,
    pub mana_cost: Option<String>,
    pub type_line: Option<String>,
    pub layout: Option<String>,
    pub finish: String,
    pub condition: String,
    pub quantity: i64,
    pub tradelist_quantity: i64,
    /// Per copy, per finish, from the blob. `None` when there is no price for that finish.
    pub unit_price_usd: Option<f64>,
    pub unit_price_eur: Option<f64>,
    pub purchase_price: Option<f64>,
    pub purchase_currency: Option<String>,
    pub acquired_at: Option<String>,
    pub acquisition_source: Option<String>,
    pub serial_number: Option<String>,
    pub altered: bool,
    pub signed: bool,
    pub proxy: bool,
    pub misprint: bool,
    pub grading: Option<String>,
    pub tags: String,
    pub notes: Option<String>,
    /// A sentence when this row needs the user's attention, `None` otherwise.
    pub needs_review: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionPage {
    pub items: Vec<CollectionRow>,
    /// Rows matching the filters, counted in full — a collection is thousands of rows, not
    /// the 116 k the search has to cap.
    pub total: i64,
}

/// The aggregate header (spec §7): total cards, unique cards, estimated value.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollectionSummary {
    /// Copies, not rows.
    pub total_cards: i64,
    pub unique_cards: i64,
    pub entries: i64,
    pub tradelist_cards: i64,
    pub value_usd: f64,
    pub value_eur: f64,
    /// Copies with no price for their finish. Shown beside the value, because a total that
    /// silently omits 400 cards is a number that lies by rounding down.
    pub unpriced_usd: i64,
    pub unpriced_eur: i64,
    pub needs_review: i64,
}

/// `FROM` + `WHERE` shared by the page, the count and the summary — because a summary
/// taken over different rows than the list is a header that describes a different screen.
fn scope(q: &CollectionQuery) -> (String, crate::filters::Predicates) {
    let mut p = crate::filters::Predicates::default();
    // LEFT JOIN, always: an entry whose printing is gone is the case the denormalised
    // columns exist for, and an inner join would delete exactly those rows from the view
    // that most needs them.
    let mut from = "collection_entries e LEFT JOIN cards c ON c.id = e.card_id".to_owned();

    if let Some(text) = crate::filters::nonblank(&q.cards.text) {
        if let Some(query) = crate::filters::fts_query(text) {
            // Searching by text is a statement about a card's name or rules, so it can only
            // match rows that still have a card — this join narrows the list to those, on
            // purpose.
            from.push_str(" JOIN cards_fts ON cards_fts.rowid = c.rowid");
            p.push("cards_fts MATCH ?".to_owned(), Box::new(query));
        }
    }
    // `paper_only` is forced off: the user owns what the user owns, and `c.is_paper = 1`
    // over a LEFT JOIN would also throw away every orphan (`NULL = 1` is not true).
    let cards = crate::filters::CardFilters {
        text: None,
        paper_only: Some(false),
        ..q.cards.clone()
    };
    crate::filters::push_card_filters(&mut p, &cards, "c");

    push_in_list(&mut p, "e.finish", q.finishes.as_deref(), &FINISHES);
    push_in_list(&mut p, "e.condition", q.conditions.as_deref(), &CONDITIONS);
    match q.needs_review {
        Some(true) => p.wheres.push("e.needs_review IS NOT NULL".to_owned()),
        Some(false) => p.wheres.push("e.needs_review IS NULL".to_owned()),
        None => {}
    }
    (from, p)
}

/// `column IN (…)` for a filter over a known enum.
///
/// Values outside the enum are dropped rather than bound: they can only come from a stale
/// or hand-made payload, they can never match, and binding them would turn a typo into an
/// empty list with no explanation.
fn push_in_list(
    p: &mut crate::filters::Predicates,
    column: &str,
    picked: Option<&[String]>,
    allowed: &[&str],
) {
    let Some(picked) = picked else { return };
    let values: Vec<String> = picked
        .iter()
        .filter(|v| allowed.contains(&v.as_str()))
        .cloned()
        .collect();
    if values.is_empty() {
        return;
    }
    let holes = vec!["?"; values.len()].join(",");
    p.wheres.push(format!("{column} IN ({holes})"));
    for v in values {
        p.params.push(Box::new(v));
    }
}

/// The `ORDER BY` for a sort key, matched against literals and never interpolated.
///
/// Every one ends in `e.id` so that ties — which are the common case, one card name
/// covering a dozen rows — page deterministically. `set` is the binder order: natural
/// collector number, which is a `CAST` because ~9% of them are not numeric (`741z`,
/// `1★`, `A-123`) and a plain string sort puts `100` before `2`.
fn order_by(sort: Option<&str>) -> &'static str {
    match sort {
        Some("set") => {
            "e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC, e.collector_number ASC, e.id ASC"
        }
        Some("added") => "e.created_at DESC, e.id DESC",
        Some("quantity") => "e.quantity DESC, coalesce(c.name, e.card_id) ASC, e.id ASC",
        Some("price") => "unit_price_usd DESC NULLS LAST, coalesce(c.name, e.card_id) ASC, e.id ASC",
        // Name order, with the orphans under their card id rather than at the top under
        // an empty string.
        _ => "coalesce(c.name, e.card_id) ASC, e.set_code ASC, CAST(e.collector_number AS INTEGER) ASC, e.id ASC",
    }
}

pub fn list_entries(conn: &Connection, q: &CollectionQuery) -> Result<CollectionPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let (from, p) = scope(q);
    let where_sql = p.where_sql();
    let mut params = p.params;

    // The count first, while `params` holds exactly the filter parameters. Counted in
    // full — this is a collection, not a 116 k-row table, and a pager that says "1 240
    // cards" should mean it.
    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let sql = format!(
        "SELECT e.id, e.card_id, c.name, e.set_code, c.set_name, e.collector_number, e.lang,
                c.rarity, c.mana_cost, c.type_line, c.layout,
                e.finish, e.condition, e.quantity, e.tradelist_quantity,
                {FINISH_PRICE_USD} AS unit_price_usd, {FINISH_PRICE_EUR} AS unit_price_eur,
                e.purchase_price, e.purchase_currency, e.acquired_at, e.acquisition_source,
                e.serial_number, e.altered, e.signed, e.proxy, e.misprint, e.grading,
                e.tags, e.notes, e.needs_review, e.updated_at
         FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
        order = order_by(q.sort.as_deref())
    );
    params.push(Box::new(limit));
    params.push(Box::new(q.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                Ok(CollectionRow {
                    id: r.get(0)?,
                    card_id: r.get(1)?,
                    name: r.get(2)?,
                    set_code: r.get(3)?,
                    set_name: r.get(4)?,
                    collector_number: r.get(5)?,
                    lang: r.get(6)?,
                    rarity: r.get(7)?,
                    mana_cost: r.get(8)?,
                    type_line: r.get(9)?,
                    layout: r.get(10)?,
                    finish: r.get(11)?,
                    condition: r.get(12)?,
                    quantity: r.get(13)?,
                    tradelist_quantity: r.get(14)?,
                    unit_price_usd: r.get(15)?,
                    unit_price_eur: r.get(16)?,
                    purchase_price: r.get(17)?,
                    purchase_currency: r.get(18)?,
                    acquired_at: r.get(19)?,
                    acquisition_source: r.get(20)?,
                    serial_number: r.get(21)?,
                    altered: r.get(22)?,
                    signed: r.get(23)?,
                    proxy: r.get(24)?,
                    misprint: r.get(25)?,
                    grading: r.get(26)?,
                    tags: r.get(27)?,
                    notes: r.get(28)?,
                    needs_review: r.get(29)?,
                    updated_at: r.get(30)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(CollectionPage { items, total })
}

/// The aggregate header, over the *same* rows the list is showing.
pub fn summarise(conn: &Connection, q: &CollectionQuery) -> Result<CollectionSummary, String> {
    let (from, p) = scope(q);
    let where_sql = p.where_sql();
    let sql = format!(
        "SELECT coalesce(sum(e.quantity), 0),
                count(DISTINCT e.card_id),
                count(*),
                coalesce(sum(e.tradelist_quantity), 0),
                coalesce(sum(e.quantity * coalesce({usd}, 0.0)), 0.0),
                coalesce(sum(e.quantity * coalesce({eur}, 0.0)), 0.0),
                coalesce(sum(CASE WHEN {usd} IS NULL THEN e.quantity ELSE 0 END), 0),
                coalesce(sum(CASE WHEN {eur} IS NULL THEN e.quantity ELSE 0 END), 0),
                coalesce(sum(CASE WHEN e.needs_review IS NOT NULL THEN 1 ELSE 0 END), 0)
         FROM {from} WHERE {where_sql}",
        usd = FINISH_PRICE_USD,
        eur = FINISH_PRICE_EUR
    );
    conn.query_row(
        &sql,
        rusqlite::params_from_iter(p.params.iter().map(|p| p.as_ref())),
        |r| {
            Ok(CollectionSummary {
                total_cards: r.get(0)?,
                unique_cards: r.get(1)?,
                entries: r.get(2)?,
                tradelist_cards: r.get(3)?,
                value_usd: r.get(4)?,
                value_eur: r.get(5)?,
                unpriced_usd: r.get(6)?,
                unpriced_eur: r.get(7)?,
                needs_review: r.get(8)?,
            })
        },
    )
    .map_err(|e| e.to_string())
}

/// The collection list. **Read-only** connection, blocking pool — as every read in this
/// app is, so a list never queues behind a sync.
#[tauri::command]
pub async fn collection_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_entries(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}

#[tauri::command]
pub async fn collection_summary(
    state: tauri::State<'_, Arc<AppState>>,
    query: CollectionQuery,
) -> Result<CollectionSummary, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        summarise(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the collection could not be read: {e}"))?
}
```

Register both commands in `lib.rs`.

- [ ] **Step 6: Run everything Rust and verify the extraction changed nothing**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: green, with `search.rs`'s suite untouched and passing — that is the extraction's proof.

- [ ] **Step 7: Commit**

```powershell
npm run verify
git add -A
git commit -m "feat: collection list and value summary over shared card filters

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Wishlist commands, and owned/wished status back in search

The mirror table, plus the loop spec §7 asks for: *"Wishlist view mirrors this; 'owned' badges appear in search once a wish is fulfilled."* Two small columns on `CardSummary` carry that, and one new filter (`owned`) finishes the filter list §7 promised.

**Files:**
- Create: `src-tauri/src/wishlist.rs`
- Modify: `src-tauri/src/search.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/wishlist.rs
pub struct WishInput { pub card_id: Option<String>, pub oracle_id: Option<String>,
                       pub name: Option<String>, pub quantity: i64,
                       pub preferred_finish: Option<String>, pub notes: Option<String> }
pub struct WishRow { … }   // includes owned_quantity: i64
pub struct WishlistPage { pub items: Vec<WishRow>, pub total: i64 }
pub fn add_wish(conn: &Connection, input: &WishInput) -> Result<EntryChange, String>;
pub fn set_wish_quantity(conn: &Connection, id: i64, quantity: i64) -> Result<EntryChange, String>;
pub fn remove_wish(conn: &Connection, id: i64) -> Result<EntryChange, String>;
pub fn list_wishes(conn: &Connection, q: &WishlistQuery) -> Result<WishlistPage, String>;
#[tauri::command] pub async fn wishlist_add/_set_quantity/_remove/_list(…);

// src-tauri/src/search.rs — two new columns on every result row, one new filter
pub struct CardSummary { …, pub owned_quantity: i64, pub wishlisted: bool }
pub struct SearchRequest { …, pub owned: Option<bool> }
```

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/wishlist.rs` with its test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        for (id, set, cn) in [("bolt-lea", "lea", "161"), ("bolt-2ed", "2ed", "162")] {
            conn.execute(
                "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,
                    prices,raw)
                 VALUES (?1,'o1','Lightning Bolt',?2,?3,'en','normal',
                    '{\"usd\":\"5.00\",\"usd_foil\":\"40.00\"}','{}')",
                rusqlite::params![id, set, cn],
            )
            .unwrap();
        }
        conn
    }

    /// The distinction spec §6 draws in one word: `card_id` NULL is "any printing", set is
    /// "that one". Both are real wishes and neither replaces the other.
    #[test]
    fn a_wish_can_be_for_any_printing_or_for_one_printing() {
        let conn = seeded();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let specific = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_ne!(any.id, specific.id);

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        assert_eq!(rows.total, 2);
        let any_row = rows.items.iter().find(|r| r.id == any.id).unwrap();
        assert_eq!(any_row.card_id, None);
        assert_eq!(any_row.name, "Lightning Bolt", "named from the printing it was made from");
        let one = rows.items.iter().find(|r| r.id == specific.id).unwrap();
        assert_eq!(one.set_code.as_deref(), Some("lea"));
    }

    /// Wishing for the same thing twice raises the number rather than making a second
    /// line on the shopping list.
    #[test]
    fn wishing_twice_for_the_same_thing_raises_the_quantity() {
        let conn = seeded();
        let first = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();
        let second = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 3,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!((first.id, second.quantity), (second.id, 4));
    }

    /// "Owned badges appear in search once a wish is fulfilled" (spec §7) needs the count
    /// of what is owned *against the wish*: any printing counts copies of the oracle card,
    /// a pinned wish counts copies of that printing only.
    #[test]
    fn a_wish_reports_how_much_of_it_is_already_owned() {
        let conn = seeded();
        crate::collection::add_entry(
            &conn,
            &crate::collection::EntryInput {
                card_id: "bolt-2ed".into(),
                finish: "nonfoil".into(),
                quantity: 2,
                ..Default::default()
            },
        )
        .unwrap();
        let any = add_wish(
            &conn,
            &WishInput {
                oracle_id: Some("o1".into()),
                quantity: 4,
                ..Default::default()
            },
        )
        .unwrap();
        let pinned = add_wish(
            &conn,
            &WishInput {
                card_id: Some("bolt-lea".into()),
                quantity: 1,
                ..Default::default()
            },
        )
        .unwrap();

        let rows = list_wishes(&conn, &WishlistQuery::default()).unwrap();
        let owned_of = |id: i64| rows.items.iter().find(|r| r.id == id).unwrap().owned_quantity;
        assert_eq!(owned_of(any.id), 2, "any Lightning Bolt counts");
        assert_eq!(owned_of(pinned.id), 0, "the Alpha one is not owned");
    }

    #[test]
    fn wish_row_json_uses_the_camel_case_names_the_frontend_expects() {
        let value = serde_json::to_value(WishRow {
            id: 3,
            oracle_id: Some("o1".into()),
            card_id: None,
            name: "Lightning Bolt".into(),
            set_code: None,
            collector_number: None,
            lang: None,
            rarity: Some("common".into()),
            mana_cost: Some("{R}".into()),
            quantity: 4,
            preferred_finish: Some("foil".into()),
            unit_price_usd: Some(40.0),
            owned_quantity: 2,
            notes: None,
            needs_review: None,
            updated_at: 1_800_000_000,
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "id": 3, "oracleId": "o1", "cardId": null, "name": "Lightning Bolt",
                "setCode": null, "collectorNumber": null, "lang": null, "rarity": "common",
                "manaCost": "{R}", "quantity": 4, "preferredFinish": "foil",
                "unitPriceUsd": 40.0, "ownedQuantity": 2, "notes": null, "needsReview": null,
                "updatedAt": 1800000000
            })
        );
    }
}
```

and append to `src-tauri/src/search.rs`'s `mod tests`:

```rust
    /// Spec §7: owned and wishlisted status travel with the result row, so the grid can
    /// badge a card the reader already has without a second round trip per tile.
    #[test]
    fn results_carry_what_the_user_owns_and_wants() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','nonfoil','NM',3,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','foil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        // An any-printing wish, matched through the oracle id rather than the printing.
        conn.execute("UPDATE cards SET oracle_id='o-bolt' WHERE id='1'", []).unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o-bolt',NULL,'Lightning Bolt',4,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let r = run_search(
            &conn,
            &SearchRequest {
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        let bolt = r.items.iter().find(|c| c.id == "1").unwrap();
        let helix = r.items.iter().find(|c| c.id == "2").unwrap();

        assert_eq!(bolt.owned_quantity, 4, "both finishes count toward 'owned'");
        assert!(bolt.wishlisted);
        assert_eq!(helix.owned_quantity, 0);
        assert!(!helix.wishlisted);
    }

    /// The filter §7 promised and Plan 2 could not build, because the table did not exist.
    /// Both directions, and the capped count has to agree with the page.
    #[test]
    fn the_owned_filter_narrows_in_both_directions() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('1','lea','161','en','nonfoil','NM',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let owned = run_search(
            &conn,
            &SearchRequest {
                owned: Some(true),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(owned.total, 1);
        assert_eq!(owned.items[0].id, "1");

        let missing = run_search(
            &conn,
            &SearchRequest {
                owned: Some(false),
                limit: 50,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(missing.total, 1);
        assert_eq!(missing.items[0].id, "2");
    }
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml wishlist
cargo test --manifest-path src-tauri/Cargo.toml results_carry
```

- [ ] **Step 3: Write `wishlist.rs`** — the module, mirroring `collection.rs`'s shape:

```rust
//! The wishlist: what the user is hunting for, at the grain spec §6 gives it — an oracle
//! card, optionally pinned to one printing and one finish.
//!
//! The interesting column is `card_id`, and it is interesting because it is **nullable**:
//! NULL means "any printing", which is what a wishlist usually means, and a value means
//! "that one", which is what it means once someone has decided they want the Alpha.

use crate::collection::{EntryChange, BUSY, FINISHES};
use crate::schema::WISHLIST_GRAIN;
use crate::sync::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

/// One wish, as the UI sends it.
///
/// Either identifier will do. A caller that sends only `cardId` gets the oracle id and the
/// name looked up from that printing (which is how the "any printing" button on a card can
/// work from a card); a caller that sends only `oracleId` must send a `name`, because
/// there may be no printing to read one from.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishInput {
    pub card_id: Option<String>,
    pub oracle_id: Option<String>,
    pub name: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    pub notes: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WishlistQuery {
    #[serde(flatten)]
    pub cards: crate::filters::CardFilters,
    /// `Some(true)` shows only wishes the collection already covers, `Some(false)` only
    /// those it does not — "what is still missing" being the list's usual question.
    pub fulfilled: Option<bool>,
    pub sort: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishRow {
    pub id: i64,
    pub oracle_id: Option<String>,
    /// `None` = any printing.
    pub card_id: Option<String>,
    pub name: String,
    pub set_code: Option<String>,
    pub collector_number: Option<String>,
    pub lang: Option<String>,
    pub rarity: Option<String>,
    pub mana_cost: Option<String>,
    pub quantity: i64,
    pub preferred_finish: Option<String>,
    /// The cheapest way to satisfy this wish, per copy: the preferred finish's price if one
    /// is named, else the nonfoil price of the printing (or of any printing of the oracle
    /// card, for an unpinned wish).
    pub unit_price_usd: Option<f64>,
    /// How many copies the collection already has against this wish.
    pub owned_quantity: i64,
    pub notes: Option<String>,
    pub needs_review: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WishlistPage {
    pub items: Vec<WishRow>,
    pub total: i64,
}

const DEFAULT_LIMIT: u32 = 100;
const MAX_LIMIT: u32 = 500;

/// How many copies the collection holds against a wish, as a scalar subquery.
///
/// A pinned wish counts that printing; an unpinned one counts every printing of the oracle
/// card, which is what "any printing" means on the way back as well as on the way out.
const OWNED_SQL: &str = "coalesce((
        SELECT sum(ce.quantity) FROM collection_entries ce
         WHERE (w.card_id IS NOT NULL AND ce.card_id = w.card_id)
            OR (w.card_id IS NULL AND ce.card_id IN
                    (SELECT id FROM cards WHERE oracle_id = w.oracle_id))), 0)";

pub fn add_wish(conn: &Connection, input: &WishInput) -> Result<EntryChange, String> {
    if let Some(f) = input.preferred_finish.as_deref() {
        if !FINISHES.contains(&f) {
            return Err(format!(
                "`{f}` is not a finish. Use one of: {}.",
                FINISHES.join(", ")
            ));
        }
    }
    let quantity = if input.quantity <= 0 { 1 } else { input.quantity };

    // Whatever the caller did not send, taken from the printing it named.
    let printing: Option<(Option<String>, String, String, String, String)> = match &input.card_id {
        Some(id) => conn
            .query_row(
                "SELECT oracle_id, name, set_code, collector_number, lang FROM cards WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?,
        None => None,
    };
    if input.card_id.is_some() && printing.is_none() {
        return Err("no card with that id is in the card database".into());
    }
    let oracle_id = input
        .oracle_id
        .clone()
        .or_else(|| printing.as_ref().and_then(|p| p.0.clone()));
    let name = input
        .name
        .clone()
        .or_else(|| printing.as_ref().map(|p| p.1.clone()))
        .ok_or("a wish needs a card name")?;
    if oracle_id.is_none() && input.card_id.is_none() {
        return Err("a wish needs either a card or an oracle id".into());
    }

    let sql = format!(
        "INSERT INTO wishlist_entries
            (oracle_id, card_id, set_code, collector_number, lang, name, quantity,
             preferred_finish, notes, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9, unixepoch(), unixepoch())
         ON CONFLICT({WISHLIST_GRAIN}) DO UPDATE SET
            quantity = wishlist_entries.quantity + excluded.quantity,
            notes = coalesce(wishlist_entries.notes, excluded.notes),
            updated_at = unixepoch()
         RETURNING id, quantity"
    );
    let (id, quantity): (i64, i64) = conn
        .query_row(
            &sql,
            params![
                oracle_id,
                input.card_id,
                printing.as_ref().map(|p| p.2.clone()),
                printing.as_ref().map(|p| p.3.clone()),
                printing.as_ref().map(|p| p.4.clone()),
                name,
                quantity,
                input.preferred_finish,
                input.notes,
            ],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

pub fn set_wish_quantity(
    conn: &Connection,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    if quantity <= 0 {
        return remove_wish(conn, id);
    }
    let changed = conn
        .execute(
            "UPDATE wishlist_entries SET quantity = ?2, updated_at = unixepoch() WHERE id = ?1",
            params![id, quantity],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("That wishlist entry is not there any more.".into());
    }
    Ok(EntryChange {
        id,
        quantity,
        removed: false,
    })
}

pub fn remove_wish(conn: &Connection, id: i64) -> Result<EntryChange, String> {
    conn.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(EntryChange {
        id,
        quantity: 0,
        removed: true,
    })
}

pub fn list_wishes(conn: &Connection, q: &WishlistQuery) -> Result<WishlistPage, String> {
    let limit = if q.limit == 0 {
        DEFAULT_LIMIT
    } else {
        q.limit.min(MAX_LIMIT)
    };
    let mut p = crate::filters::Predicates::default();
    // The card a wish is *about*: its pinned printing, or any printing of its oracle card.
    // A LEFT JOIN, because a wish outlives the printing it was made from.
    let from = "wishlist_entries w LEFT JOIN cards c
                    ON c.id = coalesce(w.card_id,
                        (SELECT id FROM cards WHERE oracle_id = w.oracle_id
                          ORDER BY released_at DESC, id ASC LIMIT 1))";
    let cards = crate::filters::CardFilters {
        text: None,
        paper_only: Some(false),
        ..q.cards.clone()
    };
    crate::filters::push_card_filters(&mut p, &cards, "c");
    if let Some(text) = crate::filters::nonblank(&q.cards.text) {
        // Matched against the stored name rather than through FTS: a wish carries its own
        // name (it may have no card row at all), and a list of a few hundred rows does not
        // need an index to filter by one.
        p.push(
            "w.name LIKE '%' || ? || '%'".to_owned(),
            Box::new(text.to_owned()),
        );
    }
    match q.fulfilled {
        Some(true) => p.wheres.push(format!("{OWNED_SQL} >= w.quantity")),
        Some(false) => p.wheres.push(format!("{OWNED_SQL} < w.quantity")),
        None => {}
    }
    let where_sql = p.where_sql();
    let mut params = p.params;

    let total: i64 = conn
        .query_row(
            &format!("SELECT count(*) FROM {from} WHERE {where_sql}"),
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;

    let order = match q.sort.as_deref() {
        Some("added") => "w.created_at DESC, w.id DESC",
        Some("price") => "unit_price_usd DESC NULLS LAST, w.name ASC, w.id ASC",
        Some("quantity") => "w.quantity DESC, w.name ASC, w.id ASC",
        _ => "w.name ASC, w.id ASC",
    };
    let sql = format!(
        "SELECT w.id, w.oracle_id, w.card_id, w.name, w.set_code, w.collector_number, w.lang,
                c.rarity, c.mana_cost, w.quantity, w.preferred_finish,
                CAST(json_extract(c.prices,
                    CASE coalesce(w.preferred_finish, 'nonfoil')
                        WHEN 'foil' THEN '$.usd_foil'
                        WHEN 'etched' THEN '$.usd_etched'
                        ELSE '$.usd' END) AS REAL) AS unit_price_usd,
                {OWNED_SQL} AS owned_quantity,
                w.notes, w.needs_review, w.updated_at
         FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
    params.push(Box::new(limit));
    params.push(Box::new(q.offset));

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(
            rusqlite::params_from_iter(params.iter().map(|p| p.as_ref())),
            |r| {
                Ok(WishRow {
                    id: r.get(0)?,
                    oracle_id: r.get(1)?,
                    card_id: r.get(2)?,
                    name: r.get(3)?,
                    set_code: r.get(4)?,
                    collector_number: r.get(5)?,
                    lang: r.get(6)?,
                    rarity: r.get(7)?,
                    mana_cost: r.get(8)?,
                    quantity: r.get(9)?,
                    preferred_finish: r.get(10)?,
                    unit_price_usd: r.get(11)?,
                    owned_quantity: r.get(12)?,
                    notes: r.get(13)?,
                    needs_review: r.get(14)?,
                    updated_at: r.get(15)?,
                })
            },
        )
        .map_err(|e| e.to_string())?;
    let items = rows
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(WishlistPage { items, total })
}

fn with_write<T>(
    state: &Arc<AppState>,
    f: impl FnOnce(&Connection) -> Result<T, String>,
) -> Result<T, String> {
    match crate::db::lock_for(&state.db, crate::db::WRITE_LOCK_WAIT) {
        Some(conn) => f(&conn),
        None => Err(BUSY.to_owned()),
    }
}

#[tauri::command]
pub async fn wishlist_add(
    state: tauri::State<'_, Arc<AppState>>,
    wish: WishInput,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| add_wish(c, &wish)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_set_quantity(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
    quantity: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        with_write(&state, |c| set_wish_quantity(c, id, quantity))
    })
    .await
    .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_remove(
    state: tauri::State<'_, Arc<AppState>>,
    id: i64,
) -> Result<EntryChange, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || with_write(&state, |c| remove_wish(c, id)))
        .await
        .map_err(|e| format!("the wishlist could not be written: {e}"))?
}

#[tauri::command]
pub async fn wishlist_list(
    state: tauri::State<'_, Arc<AppState>>,
    query: WishlistQuery,
) -> Result<WishlistPage, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        list_wishes(&crate::sync::lock_db_read(&state), &query)
    })
    .await
    .map_err(|e| format!("the wishlist could not be read: {e}"))?
}
```

- [ ] **Step 4: Add the two columns and the filter to `search.rs`** — extend `CardSummary`:

```rust
    /// Copies the collection holds of **this printing**, across every finish and
    /// condition. `0` rather than `Option`: "you own none of these" is a fact, not an
    /// absence, and a badge that has to distinguish `null` from `0` is a badge with a bug
    /// waiting in it.
    pub owned_quantity: i64,
    /// Whether a wish covers this printing — pinned to it, or unpinned on its oracle card.
    pub wishlisted: bool,
```

add the filter field to `SearchRequest`:

```rust
    /// `Some(true)` narrows to printings the collection holds, `Some(false)` to those it
    /// does not. Spec §7's owned/wishlist status filter, buildable at last now that the
    /// table exists.
    pub owned: Option<bool>,
```

and the predicate itself, which goes in `run_search` **between the `push_card_filters` call and the `let where_sql = p.where_sql(); let mut params = p.params;` pair** — after those two lines `p` has been moved and a push would not compile, let alone reach the query. It lives here rather than in `filters.rs` because it is a statement about the *user*, not about a card:

```rust
    // `EXISTS` rather than a join: a card with four collection rows must still be one
    // result row, and this way the count subquery carries the same predicate for free.
    match req.owned {
        Some(true) => p
            .wheres
            .push("EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = c.id)".to_owned()),
        Some(false) => p.wheres.push(
            "NOT EXISTS (SELECT 1 FROM collection_entries e WHERE e.card_id = c.id)".to_owned(),
        ),
        None => {}
    }
```

and the two columns on the page query only (never on the count, which does not need them):

```rust
    let sql = format!(
        "SELECT c.id, c.name, c.set_code, c.set_name, c.collector_number, c.rarity,
                c.type_line, c.mana_cost, c.price_usd, c.layout,
                coalesce((SELECT sum(e.quantity) FROM collection_entries e
                           WHERE e.card_id = c.id), 0),
                EXISTS (SELECT 1 FROM wishlist_entries w
                         WHERE w.card_id = c.id
                            OR (w.card_id IS NULL AND w.oracle_id IS NOT NULL
                                AND w.oracle_id = c.oracle_id))
         FROM {from_sql} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?"
    );
```

with `owned_quantity: row.get(10)?` and `wishlisted: row.get(11)?` in the row mapper, and the two new keys added to `search_response_json_uses_the_camel_case_names_the_frontend_expects` (`"ownedQuantity": 0, "wishlisted": false`).

- [ ] **Step 5: Register and run**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run verify
```

- [ ] **Step 6: Commit**

```powershell
git add -A
git commit -m "feat: wishlist entries, and owned/wished status on every search result

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: The migrations reconciler — repoint merges, flag deletes, never delete a user row

Spec §4.7 and the promise CLAUDE.md has been making since Plan 1: *"Orphans are flagged, never deleted."* Bulk files are additive snapshots, so a printing that Scryfall merges or discards simply stops appearing — and the user's row is left pointing at an id nothing resolves.

Two halves, and the second is the one that runs every sync: `/migrations` is *authoritative but incomplete* (it covers ids Scryfall deliberately changed), while the orphan sweep catches everything else by asking the only question that matters — does this `card_id` still resolve?

**Files:**
- Create: `src-tauri/src/reconcile.rs`
- Modify: `src-tauri/src/scryfall.rs`, `src-tauri/src/sync.rs`, `src-tauri/src/lib.rs`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/scryfall.rs
pub const MAX_MIGRATION_PAGES: usize = 10;
pub struct Migration { pub id: String, pub performed_at: Option<String>, pub strategy: String,
                       pub old_card_id: String, pub new_card_id: Option<String>,
                       pub note: Option<String> }
impl Client { pub async fn fetch_migrations(&self) -> Result<Vec<Migration>, ScryfallError>; }

// src-tauri/src/reconcile.rs
pub struct ReconcileStats { pub repointed: usize, pub folded: usize, pub flagged: usize, pub skipped: usize }
pub fn apply(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<ReconcileStats>;
pub fn sweep_orphans(conn: &Connection) -> rusqlite::Result<(usize, usize)>;
pub fn user_data_is_empty(conn: &Connection) -> bool;
```

- [ ] **Step 1: Write the failing tests** — create `src-tauri/src/reconcile.rs` with its test module:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn migration(id: &str, strategy: &str, old: &str, new: Option<&str>) -> Migration {
        Migration {
            id: id.to_owned(),
            performed_at: Some("2026-07-01T00:00:00Z".to_owned()),
            strategy: strategy.to_owned(),
            old_card_id: old.to_owned(),
            new_card_id: new.map(str::to_owned),
            note: None,
        }
    }

    fn seeded() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        crate::schema::migrate(&conn).unwrap();
        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        conn
    }

    fn own(conn: &Connection, card_id: &str, finish: &str, quantity: i64) -> i64 {
        conn.query_row(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES (?1,'lea','161','en',?2,'NM',?3,unixepoch(),unixepoch()) RETURNING id",
            rusqlite::params![card_id, finish, quantity],
            |r| r.get(0),
        )
        .unwrap()
    }

    /// A merge repoints the row *and* refreshes the printing denormalised beside it — the
    /// card the user owns is now known by a different id and, usually, a different set and
    /// number, and leaving the old ones would make the row describe a printing that no
    /// longer exists.
    #[test]
    fn a_merge_repoints_the_row_and_refreshes_its_printing() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 3);

        let stats = apply(&mut conn, &[migration("m1", "merge", "old-id", Some("new-id"))]).unwrap();

        assert_eq!(stats.repointed, 1);
        let (card, set, cn, review): (String, String, String, Option<String>) = conn
            .query_row(
                "SELECT card_id, set_code, collector_number, needs_review
                 FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .unwrap();
        assert_eq!((card.as_str(), set.as_str(), cn.as_str()), ("new-id", "2ed", "162"));
        assert_eq!(review, None, "a repointed row needs no review");
    }

    /// The case a naive `UPDATE` gets wrong: the user already owns the printing the merge
    /// points at, at the same grain. Repointing would be a unique-constraint violation, so
    /// the two rows become one and the quantities add — a merge upstream is one card, not
    /// two.
    #[test]
    fn a_merge_onto_a_row_that_already_exists_folds_the_two_together() {
        let mut conn = seeded();
        let old = own(&conn, "old-id", "foil", 3);
        let existing = own(&conn, "new-id", "foil", 2);

        let stats = apply(&mut conn, &[migration("m1", "merge", "old-id", Some("new-id"))]).unwrap();

        assert_eq!((stats.repointed, stats.folded), (0, 1));
        let quantity: i64 = conn
            .query_row(
                "SELECT quantity FROM collection_entries WHERE id = ?1",
                [existing],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(quantity, 5, "three plus two, in the row that survived");
        let gone: i64 = conn
            .query_row(
                "SELECT count(*) FROM collection_entries WHERE id = ?1",
                [old],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(gone, 0, "and the folded row is gone, not duplicated");
    }

    /// The promise CLAUDE.md makes: a delete **flags**. The user paid for that card; a
    /// tracker that quietly removes it because an upstream database tidied its ids has
    /// destroyed the only record of it.
    #[test]
    fn a_delete_flags_the_row_and_never_removes_it() {
        let mut conn = seeded();
        let id = own(&conn, "gone-id", "nonfoil", 1);
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o9','gone-id','Vanished',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let stats = apply(&mut conn, &[migration("m2", "delete", "gone-id", None)]).unwrap();

        assert_eq!(stats.flagged, 2, "both tables");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        let review = review.expect("the row must be flagged");
        assert!(review.contains("2026-07-01"), "{review}");
        let rows: i64 = conn
            .query_row("SELECT count(*) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "flagged, never deleted");
    }

    /// `/migrations` is a growing log that is re-read on every poll. Applying a merge twice
    /// would be harmless; applying a *fold* twice would double a quantity. The applied set
    /// is recorded, and this is what keeps the second poll a no-op.
    #[test]
    fn a_migration_that_has_already_been_applied_is_skipped() {
        let mut conn = seeded();
        own(&conn, "old-id", "foil", 3);
        let m = [migration("m1", "merge", "old-id", Some("new-id"))];

        let first = apply(&mut conn, &m).unwrap();
        let second = apply(&mut conn, &m).unwrap();

        assert_eq!(first.repointed, 1);
        assert_eq!((second.repointed, second.folded, second.skipped), (0, 0, 1));
        let quantity: i64 = conn
            .query_row("SELECT sum(quantity) FROM collection_entries", [], |r| r.get(0))
            .unwrap();
        assert_eq!(quantity, 3, "a re-poll must not add cards to the collection");
    }

    /// A merge into an id this database has never seen — Scryfall moved a card to a
    /// printing that arrives in a later bulk file. The row is repointed anyway (the id is
    /// the truth) but flagged, because until that card lands the row cannot be priced or
    /// pictured and the user should know why.
    #[test]
    fn a_merge_into_an_unknown_card_is_repointed_and_flagged() {
        let mut conn = seeded();
        let id = own(&conn, "old-id", "foil", 1);

        apply(&mut conn, &[migration("m3", "merge", "old-id", Some("not-here-yet"))]).unwrap();

        let (card, review): (String, Option<String>) = conn
            .query_row(
                "SELECT card_id, needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(card, "not-here-yet");
        assert!(review.is_some(), "the user should know the card is not here");
    }

    /// The half that does not need Scryfall's log at all: after every ingest, a row whose
    /// `card_id` no longer resolves is flagged, and one that resolves again is cleared.
    /// The second direction matters — a printing can come back (a bad bulk file, a
    /// re-added card), and a flag nobody can clear is a permanent scar.
    #[test]
    fn the_orphan_sweep_flags_what_vanished_and_clears_what_came_back() {
        let conn = seeded();
        let id = own(&conn, "new-id", "foil", 1);

        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 0), "nothing is wrong yet");

        conn.execute("DELETE FROM cards WHERE id = 'new-id'", []).unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap().0, 1);
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert!(review.unwrap().contains("card database"));

        conn.execute(
            "INSERT INTO cards (id,oracle_id,name,set_code,collector_number,lang,layout,raw)
             VALUES ('new-id','o1','Lightning Bolt','2ed','162','en','normal','{}')",
            [],
        )
        .unwrap();
        assert_eq!(sweep_orphans(&conn).unwrap(), (0, 1), "and it clears again");
        let review: Option<String> = conn
            .query_row(
                "SELECT needs_review FROM collection_entries WHERE id = ?1",
                [id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(review, None);
    }

    /// Scryfall asks applications not to make requests they do not need. A user with no
    /// rows has nothing to reconcile, so the poll does not happen at all.
    #[test]
    fn a_database_with_no_user_rows_is_not_worth_a_request() {
        let conn = seeded();
        assert!(user_data_is_empty(&conn));
        own(&conn, "new-id", "foil", 1);
        assert!(!user_data_is_empty(&conn));
    }
}
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml reconcile
```

- [ ] **Step 3: Add `/migrations` to the client** — in `src-tauri/src/scryfall.rs`:

```rust
/// Pages `fetch_migrations` will follow. ~350 migrations exist in total and the endpoint
/// pages like every other Scryfall list; the cap is the same guard `fetch_sets` carries
/// against a `next_page` chain that cycles.
pub const MAX_MIGRATION_PAGES: usize = 10;

/// One entry of Scryfall's id-migration log.
///
/// The reason a collection tracker cares: bulk files are *additive snapshots*, so a card
/// whose id was merged or discarded simply stops appearing in them, and a user row keyed on
/// that id is orphaned with no event to explain it. This log is the event.
#[derive(Debug, Clone)]
pub struct Migration {
    pub id: String,
    pub performed_at: Option<String>,
    /// `merge` or `delete`. Anything else is a strategy this app does not know, and the
    /// reconciler skips it rather than guessing at what it means.
    pub strategy: String,
    pub old_card_id: String,
    /// `None` for `delete`, which is the whole difference between the two.
    pub new_card_id: Option<String>,
    pub note: Option<String>,
}

impl Client {
    /// The id-migration log, newest page first, bounded by [`MAX_MIGRATION_PAGES`].
    pub async fn fetch_migrations(&self) -> Result<Vec<Migration>, ScryfallError> {
        let mut url = format!("{}/migrations", self.base_url);
        let mut out = Vec::new();
        for _ in 0..MAX_MIGRATION_PAGES {
            let resp = self.api_get(&url).send().await?;
            match resp.status().as_u16() {
                200 => {}
                429 => {
                    return Err(ScryfallError::RateLimited {
                        retry_after_secs: retry_after_secs(&resp),
                    })
                }
                s => return Err(ScryfallError::Unexpected(format!("status {s}"))),
            }
            let v = json_body(resp).await?;
            for m in v["data"].as_array().into_iter().flatten() {
                // A row with no id or no old id describes nothing this app can act on.
                let (Some(id), Some(old)) = (
                    m["id"].as_str(),
                    m["old_scryfall_id"].as_str(),
                ) else {
                    continue;
                };
                out.push(Migration {
                    id: id.to_owned(),
                    performed_at: m["performed_at"].as_str().map(str::to_owned),
                    strategy: m["migration_strategy"].as_str().unwrap_or_default().to_owned(),
                    old_card_id: old.to_owned(),
                    new_card_id: m["new_scryfall_id"].as_str().map(str::to_owned),
                    note: m["note"].as_str().map(str::to_owned),
                });
            }
            if v["has_more"].as_bool() != Some(true) {
                break;
            }
            let next = v["next_page"].as_str().unwrap_or_default().to_owned();
            if next.is_empty() || next == url {
                break;
            }
            url = next;
        }
        Ok(out)
    }
}
```

with a mocked test beside `fetch_sets`'s, covering both strategies and the page cap.

- [ ] **Step 4: Write the reconciler** — the rest of `src-tauri/src/reconcile.rs`:

```rust
//! Scryfall's id migrations, applied to the user's own rows.
//!
//! The rule the whole module exists to keep, from CLAUDE.md and spec §4.7: **a merge
//! repoints, a delete flags, and nothing here ever removes a row the user created.** A
//! collection tracker that silently drops a card because an upstream database tidied its
//! identifiers has destroyed the only record of something the user paid for.

use crate::scryfall::Migration;
use rusqlite::{params, Connection, OptionalExtension};

/// What one pass did.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ReconcileStats {
    pub repointed: usize,
    pub folded: usize,
    pub flagged: usize,
    /// Migrations already applied, or of a strategy this app does not know.
    pub skipped: usize,
}

/// Is there any user data to reconcile at all?
///
/// Scryfall asks applications not to make requests they do not need, and a database with no
/// collection and no wishlist has nothing an id migration could be about.
pub fn user_data_is_empty(conn: &Connection) -> bool {
    let count = |sql: &str| conn.query_row(sql, [], |r| r.get::<_, i64>(0)).unwrap_or(1);
    count("SELECT count(*) FROM collection_entries") == 0
        && count("SELECT count(*) FROM wishlist_entries") == 0
}

/// Apply every migration this database has not already applied.
///
/// One transaction for the whole pass: half-applied merges would leave rows pointing at
/// ids that no longer describe what they own.
pub fn apply(conn: &mut Connection, migrations: &[Migration]) -> rusqlite::Result<ReconcileStats> {
    let mut stats = ReconcileStats::default();
    let tx = conn.transaction()?;
    for m in migrations {
        let already: bool = tx
            .query_row(
                "SELECT 1 FROM card_migrations WHERE id = ?1",
                params![m.id],
                |_| Ok(true),
            )
            .optional()?
            .unwrap_or(false);
        // Re-polling the log is normal — it is a growing list, not a queue. Applying a
        // *fold* twice would double a quantity, so "have I seen this?" is the only thing
        // standing between a re-poll and a collection that grows on its own.
        if already {
            stats.skipped += 1;
            continue;
        }
        match (m.strategy.as_str(), m.new_card_id.as_deref()) {
            ("merge", Some(new_id)) => merge(&tx, m, new_id, &mut stats)?,
            ("delete", _) => stats.flagged += flag_deleted(&tx, m)?,
            // A strategy this app has never heard of, or a merge with nowhere to merge to.
            // Recorded as applied all the same: guessing at it later would be no better
            // informed than guessing at it now.
            _ => stats.skipped += 1,
        }
        tx.execute(
            "INSERT OR IGNORE INTO card_migrations
                (id, performed_at, strategy, old_card_id, new_card_id, note, applied_at)
             VALUES (?1,?2,?3,?4,?5,?6, unixepoch())",
            params![
                m.id,
                m.performed_at,
                // The CHECK on the table only knows two strategies, and an unknown one must
                // not fail the pass — it is stored as what it did, which is nothing.
                if m.strategy == "delete" { "delete" } else { "merge" },
                m.old_card_id,
                m.new_card_id,
                m.note
            ],
        )?;
    }
    tx.commit()?;
    Ok(stats)
}

/// Repoint every row on `old_card_id`, folding any that collide with a row already at the
/// new id.
fn merge(
    tx: &rusqlite::Transaction<'_>,
    m: &Migration,
    new_id: &str,
    stats: &mut ReconcileStats,
) -> rusqlite::Result<()> {
    // The printing as the *new* card describes it. `None` when that card has not arrived in
    // a bulk file yet, which is a real state: the migration log is published before the
    // next bulk rotation carries the card.
    let printing: Option<(String, String, String)> = tx
        .query_row(
            "SELECT set_code, collector_number, lang FROM cards WHERE id = ?1",
            params![new_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let note = match &printing {
        Some(_) => None,
        None => Some(format!(
            "Scryfall merged this printing into {new_id}, which is not in the card database \
             yet. It should arrive with the next card-data sync."
        )),
    };

    let ids: Vec<i64> = tx
        .prepare("SELECT id FROM collection_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in ids {
        let repointed = tx.execute(
            "UPDATE OR IGNORE collection_entries
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                new_id,
                printing.as_ref().map(|p| p.0.clone()),
                printing.as_ref().map(|p| p.1.clone()),
                printing.as_ref().map(|p| p.2.clone()),
                note
            ],
        )?;
        if repointed == 1 {
            stats.repointed += 1;
            continue;
        }
        // `OR IGNORE` swallowed a unique-constraint violation, which can only mean the
        // collection already holds this exact grain at the new id. Two rows for what
        // upstream now says is one card is one row with both quantities.
        fold_into_existing(tx, id, new_id)?;
        stats.folded += 1;
    }

    // A wishlist row has no quantity to fold — the grain is looser and a duplicate is
    // simply dropped in favour of the one already there.
    let wishes: Vec<i64> = tx
        .prepare("SELECT id FROM wishlist_entries WHERE card_id = ?1")?
        .query_map(params![m.old_card_id], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for id in wishes {
        let moved = tx.execute(
            "UPDATE OR IGNORE wishlist_entries
                SET card_id = ?2,
                    set_code = coalesce(?3, set_code),
                    collector_number = coalesce(?4, collector_number),
                    lang = coalesce(?5, lang),
                    needs_review = ?6,
                    updated_at = unixepoch()
              WHERE id = ?1",
            params![
                id,
                new_id,
                printing.as_ref().map(|p| p.0.clone()),
                printing.as_ref().map(|p| p.1.clone()),
                printing.as_ref().map(|p| p.2.clone()),
                note
            ],
        )?;
        if moved == 1 {
            stats.repointed += 1;
        } else {
            tx.execute("DELETE FROM wishlist_entries WHERE id = ?1", params![id])?;
            stats.folded += 1;
        }
    }
    Ok(())
}

/// Add a row's quantities to the row that blocked its repointing, then delete it.
///
/// The target is found by the grain, spelled out here rather than shared with
/// `schema::COLLECTION_GRAIN`: that constant is a list of *expressions over one row*, and
/// this needs the same list compared *between two rows*.
fn fold_into_existing(
    tx: &rusqlite::Transaction<'_>,
    source: i64,
    new_id: &str,
) -> rusqlite::Result<()> {
    tx.execute(
        "UPDATE collection_entries SET
            quantity = quantity + (SELECT quantity FROM collection_entries WHERE id = ?1),
            tradelist_quantity = tradelist_quantity
                + (SELECT tradelist_quantity FROM collection_entries WHERE id = ?1),
            updated_at = unixepoch()
          WHERE id = (
            SELECT t.id FROM collection_entries t, collection_entries s
             WHERE s.id = ?1 AND t.id <> s.id AND t.card_id = ?2
               AND t.finish = s.finish AND t.condition = s.condition AND t.lang = s.lang
               AND t.altered = s.altered AND t.signed = s.signed AND t.proxy = s.proxy
               AND t.misprint = s.misprint
               AND coalesce(t.serial_number,'') = coalesce(s.serial_number,'')
               AND coalesce(t.grading,'') = coalesce(s.grading,''))",
        params![source, new_id],
    )?;
    tx.execute("DELETE FROM collection_entries WHERE id = ?1", params![source])?;
    Ok(())
}

/// Flag every row that referred to a discarded id. Returns how many were flagged.
fn flag_deleted(tx: &rusqlite::Transaction<'_>, m: &Migration) -> rusqlite::Result<usize> {
    let when = m.performed_at.as_deref().unwrap_or("an earlier date");
    let note = format!(
        "Scryfall removed this printing from its database on {when}. \
         Your copies are still recorded — check the printing and re-add it if you can \
         identify it, or remove this entry."
    );
    let mut flagged = 0;
    for table in ["collection_entries", "wishlist_entries"] {
        flagged += tx.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?2, updated_at = unixepoch()
                  WHERE card_id = ?1 AND needs_review IS NULL"
            ),
            params![m.old_card_id, note],
        )?;
    }
    Ok(flagged)
}

/// Flag every row whose `card_id` no longer resolves, and clear every flag whose card is
/// back. Returns `(flagged, cleared)`.
///
/// Run after every ingest. `/migrations` explains the ids Scryfall changed *deliberately*;
/// this asks the only question the user cares about — can this row still be shown? — and
/// it needs no network at all.
pub fn sweep_orphans(conn: &Connection) -> rusqlite::Result<(usize, usize)> {
    const MISSING: &str =
        "This printing is not in the card database. It may have been removed by the last \
         card-data sync, or it may return with the next one.";
    let mut flagged = 0;
    let mut cleared = 0;
    for table in ["collection_entries", "wishlist_entries"] {
        flagged += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = ?1, updated_at = unixepoch()
                  WHERE needs_review IS NULL AND card_id IS NOT NULL
                    AND NOT EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            params![MISSING],
        )?;
        // The other direction, and the reason a flag is a sentence rather than a boolean: a
        // printing that comes back — a bad bulk file, a re-added card — clears its own
        // flag, so a transient gap does not leave a permanent scar on the row.
        cleared += conn.execute(
            &format!(
                "UPDATE {table} SET needs_review = NULL, updated_at = unixepoch()
                  WHERE needs_review IS NOT NULL AND card_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM cards WHERE cards.id = {table}.card_id)"
            ),
            [],
        )?;
    }
    Ok((flagged, cleared))
}
```

- [ ] **Step 5: Run it on every sync** — in `src-tauri/src/sync.rs`, add to `do_sync` right after the `incremental_vacuum` block (so it follows the swap, on the path that changed `cards`):

```rust
    {
        // The half that needs no network: after a swap, a row whose printing is gone is
        // flagged, and a row whose printing came back is cleared.
        let conn = lock_db(state);
        match crate::reconcile::sweep_orphans(&conn) {
            Ok((flagged, cleared)) if flagged > 0 || cleared > 0 => {
                eprintln!("collection review: {flagged} rows flagged, {cleared} cleared")
            }
            Ok(_) => {}
            Err(e) => eprintln!("could not sweep for orphaned collection rows: {e}"),
        }
    }
```

and, on both the updated and unchanged paths, poll the log — `finish_unchanged` and the tail of `do_sync` both call:

```rust
    reconcile_ids(state, app).await;
```

with:

```rust
/// Poll Scryfall's id-migration log and apply it to the user's rows.
///
/// On the same 24 h cadence as everything else here, because it is called from the same two
/// places a sync can finish. Skipped entirely when there is nothing to reconcile: Scryfall
/// asks applications not to make requests they do not need, and a database with no
/// collection and no wishlist has no ids to migrate.
///
/// A failure is logged and dropped. The bulk data is ingested either way, and an id
/// migration that did not apply today applies tomorrow — whereas failing the whole sync
/// over it would cost the user their card update.
async fn reconcile_ids(state: &Arc<AppState>, app: &tauri::AppHandle) {
    let worth_it = {
        let conn = lock_db_read(state);
        !crate::reconcile::user_data_is_empty(&conn)
    };
    if !worth_it {
        return;
    }
    let migrations = match state.client.fetch_migrations().await {
        Ok(m) => m,
        Err(e) => {
            eprintln!("could not read Scryfall's id migrations: {e}");
            return;
        }
    };
    let state = state.clone();
    let applied = tauri::async_runtime::spawn_blocking(move || {
        let mut conn = lock_db(&state);
        crate::reconcile::apply(&mut conn, &migrations)
    })
    .await;
    match applied {
        Ok(Ok(stats)) if stats.repointed + stats.folded + stats.flagged > 0 => {
            let _ = app.emit(
                "collection:reconciled",
                serde_json::json!({
                    "repointed": stats.repointed,
                    "folded": stats.folded,
                    "flagged": stats.flagged,
                }),
            );
        }
        Ok(Ok(_)) => {}
        Ok(Err(e)) => eprintln!("could not apply Scryfall's id migrations: {e}"),
        Err(e) => eprintln!("the id-migration task failed: {e}"),
    }
}
```

- [ ] **Step 6: Run everything and verify**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
npm run verify
```

- [ ] **Step 7: Commit**

```powershell
git add -A
git commit -m "feat: reconcile Scryfall id migrations and flag orphaned user rows

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: The frontend foundation — DTOs, the finish and condition vocabularies, shared chrome

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** This task creates the pieces the next three build from, so its judgment calls (the rarity gem's markup, the chip vocabulary, the dim-text token) are the ones the whole plan inherits.

Everything the views need before they exist: the hand-mirrored IPC types, the two domain vocabularies (finishes and conditions), one home for price formatting, and three pieces of shared chrome. It also lands the carryover's **`--muted` rename** — before the new UI is written, so that none of it is written against the token that is about to move.

**Files:**
- Create: `src/lib/finish.ts` + `.test.ts`, `src/lib/prices.ts` + `.test.ts`, `src/lib/tokens.test.ts`, `src/components/RarityGem.tsx` + `.test.tsx`, `src/components/FilterChips.tsx` + `.test.tsx`, `src/features/collection/conditions.ts` + `.test.ts`
- Modify: `src/lib/ipc.ts`, `src/lib/ipc.test.ts`, `src/lib/store.ts`, `src/index.css`, `src/features/card/printings.ts` (+ test), `src/features/card/CardDetailPane.tsx`, `src/features/search/SearchPage.tsx`, `src/features/search/CardGrid.tsx`, `src/features/search/FilterBar.tsx`, and every file using `text-muted`

**Interfaces:**
- Produces:

```ts
// src/lib/finish.ts
export const FINISHES: readonly ["nonfoil", "foil", "etched"];
export type Finish = (typeof FINISHES)[number];
export const FINISH_LABEL: Record<Finish, string>;
export const FINISH_MARK: Record<Finish, string>;      // "" | "F" | "E"
export function isFinish(value: string): value is Finish;
export function parseFinishes(json: string | null): Finish[];
export function finishPrice(pricesJson: string | null, finish: Finish): number | null;

// src/lib/prices.ts
export const PRICES_AS_OF = "Prices as of the last card-data sync.";
export function usdPrice(value: number | null): string;   // "—" when null, never "$0.00"
export function eurPrice(value: number | null): string;

// src/features/collection/conditions.ts
export const CONDITIONS: readonly ["NM", "LP", "MP", "HP", "DMG"];
export type Condition = (typeof CONDITIONS)[number];
export const CONDITION_LABEL: Record<Condition, string>;
export function normalizeCondition(raw: string | null | undefined):
  { condition: Condition; original: string | null; matched: boolean };

// src/components/RarityGem.tsx
export function RarityGem(props: { rarity: string | null; withLabel?: boolean; className?: string }): JSX.Element;

// src/components/FilterChips.tsx
export const FILTER_FOCUS: string;    // the outline every filter control shares
export const FILTER_CONTROL: string;  // 36px height, border, 150ms transition
export function ManaChip(props: { symbol: ManaKey; pressed: boolean; onClick: () => void }): JSX.Element;
export function ManaValueChips(props: { selected: readonly number[]; onToggle: (v: number) => void }): JSX.Element;
export function ToggleChip(props: { label: string; pressed: boolean; onClick: () => void }): JSX.Element;
export function ResetAll(props: { count: number; onReset: () => void }): JSX.Element;
```

- [ ] **Step 1: Write the failing vocabulary tests** — create `src/features/collection/conditions.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { CONDITIONS, normalizeCondition } from "./conditions";

describe("normalizeCondition", () => {
  it("maps every spelling in the research doc's synonym table", () => {
    const cases: [string, string][] = [
      ["Mint", "NM"],
      ["M", "NM"],
      ["MT", "NM"],
      ["Near Mint", "NM"],
      ["nm", "NM"],
      ["SP", "LP"],
      ["Excellent", "LP"],
      ["EX", "LP"],
      ["Good (Lightly Played)", "LP"],
      ["Moderately Played", "MP"],
      ["GD", "MP"],
      ["Played", "MP"],
      ["Heavily Played", "HP"],
      ["PO", "HP"],
      ["Damaged", "DMG"],
      ["DM", "DMG"],
      ["D", "DMG"],
    ];
    for (const [raw, expected] of cases) {
      expect(normalizeCondition(raw), raw).toMatchObject({ condition: expected, matched: true });
    }
  });

  /**
   * The false friend, ruled on: a bare `LP` is the NA scale's Lightly Played, because the
   * NA scale is this app's own. Cardmarket's LP sits at NA Played, but *which scale a file
   * is on* is a property of the file — so that re-reading belongs to the importer, which
   * knows the source, and not to a function that only sees two letters.
   */
  it("reads a bare LP on the app's own scale", () => {
    expect(normalizeCondition("LP").condition).toBe("LP");
    expect(normalizeCondition("Lightly Played").condition).toBe("LP");
  });

  /** The original string is always kept: the normalisation is lossy and the user's file is
   *  the only place the difference still exists. */
  it("keeps what it was given, and says when it did not recognise it", () => {
    expect(normalizeCondition("Poor-ish")).toEqual({
      condition: "NM",
      original: "Poor-ish",
      matched: false,
    });
    expect(normalizeCondition(null)).toEqual({ condition: "NM", original: null, matched: true });
    expect(normalizeCondition("  near mint  ").original).toBe("near mint");
  });

  it("has five grades, worst last", () => {
    expect(CONDITIONS).toEqual(["NM", "LP", "MP", "HP", "DMG"]);
  });
});
```

and `src/lib/finish.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { finishPrice, isFinish, parseFinishes } from "./finish";

const PRICES = `{"usd":"5.00","usd_foil":"40.00","usd_etched":null,"eur":"4.20","tix":"0.03"}`;

describe("finishPrice", () => {
  /**
   * A lookup by finish with **no fallback of any kind**. `price_usd` — the derived column
   * — is a nonfoil→foil→etched chain built for sorting, and using it here would price a
   * plain copy at foil rates.
   */
  it("reads the key its finish is worth, and nothing else", () => {
    expect(finishPrice(PRICES, "nonfoil")).toBe(5);
    expect(finishPrice(PRICES, "foil")).toBe(40);
    expect(finishPrice(PRICES, "etched")).toBeNull();
  });

  it("is null rather than zero for anything unreadable", () => {
    expect(finishPrice(null, "nonfoil")).toBeNull();
    expect(finishPrice("not json", "nonfoil")).toBeNull();
    expect(finishPrice(`{"usd":"not a number"}`, "nonfoil")).toBeNull();
  });
});

describe("parseFinishes", () => {
  it("keeps the enum and drops anything else", () => {
    expect(parseFinishes(`["nonfoil","foil","glossy"]`)).toEqual(["nonfoil", "foil"]);
    expect(parseFinishes(null)).toEqual([]);
    expect(isFinish("foil")).toBe(true);
    expect(isFinish("Foil")).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

```powershell
npm run test:run -- conditions finish
```

- [ ] **Step 3: Write the vocabularies** — `src/features/collection/conditions.ts`:

```ts
/**
 * Condition grades, and the strings the rest of the world writes them as.
 *
 * The app stores one of five NA-scale grades and **keeps the original string** beside it,
 * because the normalisation is lossy: EU `GD` and NA `MP` arrive as the same grade, and
 * the user's own file is then the only place the difference still exists.
 */
export const CONDITIONS = ["NM", "LP", "MP", "HP", "DMG"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** Sentence case, as every other label in the app is. */
export const CONDITION_LABEL: Record<Condition, string> = {
  NM: "Near mint",
  LP: "Lightly played",
  MP: "Moderately played",
  HP: "Heavily played",
  DMG: "Damaged",
};

/**
 * Every spelling this app recognises, lower-cased.
 *
 * From the research doc's synonym table. Two entries are the EU scale's, and they are here
 * only because those spellings never come from anywhere else: `EX` (≈ NA Lightly Played)
 * and `GD` (≈ NA Moderately Played). A bare **`LP` is deliberately not remapped** — it is
 * the NA scale's own grade, and Cardmarket's LP-means-Played is a property of the *file*,
 * so it belongs to the importer that knows which file it is reading (Plan 5).
 */
const SYNONYMS: Record<string, Condition> = {
  mint: "NM",
  m: "NM",
  mt: "NM",
  "near mint": "NM",
  nm: "NM",
  "nm-mint": "NM",
  sp: "LP",
  "slightly played": "LP",
  excellent: "LP",
  ex: "LP",
  "lightly played": "LP",
  lp: "LP",
  "good (lightly played)": "LP",
  "moderately played": "MP",
  mp: "MP",
  played: "MP",
  good: "MP",
  gd: "MP",
  "heavily played": "HP",
  hp: "HP",
  poor: "HP",
  po: "HP",
  damaged: "DMG",
  dmg: "DMG",
  dm: "DMG",
  d: "DMG",
};

/**
 * One incoming condition string, as a grade plus what it said.
 *
 * `matched: false` is not an error — it is what an import preview shows as a warning row
 * (spec §7: "unknown conditions" are one of the three things a preview flags). The grade
 * defaults to `NM` because that is what an unmarked card is assumed to be.
 */
export function normalizeCondition(raw: string | null | undefined): {
  condition: Condition;
  original: string | null;
  matched: boolean;
} {
  const original = raw?.trim() ?? null;
  if (!original) return { condition: "NM", original: null, matched: true };
  const found = SYNONYMS[original.toLowerCase()];
  return { condition: found ?? "NM", original, matched: found !== undefined };
}
```

and `src/lib/finish.ts` — the vocabulary moved out of `features/card/printings.ts` and `CardDetailPane.tsx`, which both had a private copy:

```ts
/**
 * Scryfall's finish enum, and what a finish is worth.
 *
 * A module of its own because three views now need it: the card pane prices every finish a
 * printing exists in, the quick-add popup offers them as a choice, and the collection
 * stores one per row. It is an enum and never a boolean — `etched` is a third thing, and
 * flattening it into `foil: true` is the single most common way an importer loses data.
 */
export const FINISHES = ["nonfoil", "foil", "etched"] as const;
export type Finish = (typeof FINISHES)[number];

export const FINISH_LABEL: Record<Finish, string> = {
  nonfoil: "Nonfoil",
  foil: "Foil",
  etched: "Etched",
};

/**
 * How a finish is marked where there is no room for a word.
 *
 * Nonfoil is unmarked because it is the default a price is assumed to be; the two that are
 * not carry a letter, and the letter is rendered inside an `<abbr>` so its full word is one
 * hover — or one screen reader — away.
 */
export const FINISH_MARK: Record<Finish, string> = { nonfoil: "", foil: "F", etched: "E" };

/** The `prices` key each finish is worth. `eur_etched` does not exist in the data. */
const PRICE_KEY: Record<Finish, string> = {
  nonfoil: "usd",
  foil: "usd_foil",
  etched: "usd_etched",
};

export function isFinish(value: string): value is Finish {
  return (FINISHES as readonly string[]).includes(value);
}

/** The finishes a printing exists in. Unknown values are dropped, not guessed at. */
export function parseFinishes(json: string | null): Finish[] {
  const parsed = safeParse(json);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((f): f is Finish => typeof f === "string" && isFinish(f));
}

/**
 * What one finish of a printing costs in USD, or `null`.
 *
 * A lookup by finish, with **no fallback of any kind**. `price_usd` — the derived column —
 * is a nonfoil→foil→etched chain built for sorting, and using it here would price a plain
 * copy at foil rates. Values arrive as decimal strings because money is not a float on the
 * wire; `Number` is the last possible moment to make one.
 */
export function finishPrice(pricesJson: string | null, finish: Finish): number | null {
  const prices = safeParse(pricesJson);
  if (typeof prices !== "object" || prices === null) return null;
  const raw = (prices as Record<string, unknown>)[PRICE_KEY[finish]];
  if (typeof raw !== "string") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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

`src/features/card/printings.ts` loses `Finish`, `FINISHES`, `PRICE_KEY`, `parseFinishes` and `finishPrice` (it keeps its own `safeParse` for legalities, and keeps `groupByIllustration`, `legalityChips`, `faceCount` and `FORMAT_ORDER`). `CardDetailPane.tsx` then imports `type Finish`, `FINISH_LABEL`, `FINISH_MARK`, `parseFinishes` and `finishPrice` from `@/lib/finish` — including the `Finish` type, which it currently takes from `./printings` — and deletes its two local `FINISH_*` records. `printings.test.ts` loses the `finishPrice`/`parseFinishes` blocks to `finish.test.ts`; nothing else in it moves.

- [ ] **Step 4: One home for price text** — create `src/lib/prices.ts`:

```ts
/**
 * Money, as this app writes it.
 *
 * Three call sites had their own `Intl.NumberFormat` and two had their own copy of the
 * as-of sentence — which is exactly the kind of duplication that ends with two screens
 * making different promises about the same number. Prices come from one place (whatever
 * the last sync wrote), so they say so in one sentence.
 */
export const PRICES_AS_OF = "Prices as of the last card-data sync.";

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const EUR = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR" });

/** A price, or an em dash. Never `$0.00`, which is a price nobody quoted. */
export function usdPrice(value: number | null): string {
  return value === null ? "—" : USD.format(value);
}

export function eurPrice(value: number | null): string {
  return value === null ? "—" : EUR.format(value);
}
```

and replace the local `usd`/`price`/`PRICES_AS_OF` declarations in `SearchPage.tsx` and `CardDetailPane.tsx` with imports.

- [ ] **Step 5: Rename the dim-text token** — carryover item 4. The app's `--color-muted` means *dim text*, while shadcn's `muted` means *a subtle surface*, and Tailwind builds `bg-muted` and `text-muted` from the same literal — so the two meanings cannot both be served by one token. Rename ours and give shadcn its own back:

In `src/index.css`'s `@theme` block:

```css
  /* Dim text. Named `dim` rather than `muted` because shadcn's `muted` means a subtle
     *surface*, Tailwind derives `bg-muted` and `text-muted` from the same literal, and one
     token cannot be both. Renaming ours is what finally lets `--color-muted` below mean
     what every vendored component expects it to. */
  --color-dim: oklch(0.65 0.01 90);
  /* shadcn's meaning, restored: `bg-muted` is now a subtle panel, as every generated
     component assumes. Vendoring one no longer needs the `bg-muted` → `bg-surface`
     rewrite CLAUDE.md used to require. */
  --color-muted: var(--color-surface);
```

and in both `:root` and `.dark`, `--muted-foreground: var(--color-dim);` (the `--muted: var(--color-surface)` line stays and its warning comment is replaced by a one-liner: `/* The surface half of shadcn's pair; `--color-muted` above now agrees with it. */`).

Then the mechanical half:

```powershell
# Every dim-text usage in the app, which is the only thing that changes.
rg -l "text-muted\b" src | ForEach-Object { (Get-Content $_ -Raw) -replace "text-muted\b", "text-dim" | Set-Content $_ -NoNewline }
rg -n "text-muted\b|placeholder:text-muted" src   # expect: no matches
rg -n "text-dim" src | Measure-Object -Line       # expect: ~42 lines
```

`text-muted-foreground` must **not** be touched — the word boundary in the pattern is what protects it, and the second `rg` is the check.

- [ ] **Step 6: Pin the rename** — create `src/lib/tokens.test.ts`:

```ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const CSS = readFileSync("src/index.css", "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) ? [path] : [];
  });
}

describe("colour tokens", () => {
  /**
   * The tripwire this rename removed: Tailwind builds `bg-muted` *and* `text-muted` from
   * one `--color-muted` literal, so as long as that literal was the app's dim *text*
   * colour, every vendored shadcn component rendered text on the same colour as its
   * background (a stock `TabsList` had invisible labels). Ours is `--color-dim` now, and
   * `--color-muted` means what shadcn means by it.
   */
  it("keeps dim text and the muted surface as two different tokens", () => {
    expect(CSS).toMatch(/--color-dim:\s*oklch/);
    expect(CSS).toMatch(/--color-muted:\s*var\(--color-surface\)/);
    expect(CSS).toMatch(/--muted-foreground:\s*var\(--color-dim\)/);
  });

  /**
   * A guard rather than a ceremony test: `text-muted` still *compiles* — it is now a
   * surface colour on text, which renders as very nearly invisible rather than as an
   * error. The failure mode is a screen nobody can read, found by a user.
   */
  it("has no `text-muted` left anywhere in the app", () => {
    const offenders = sourceFiles("src").filter((file) =>
      /\btext-muted\b(?!-foreground)/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
```

- [ ] **Step 7: The two pieces of shared chrome** — `src/components/RarityGem.tsx`, which four surfaces had a copy of:

```tsx
import { rarityColor } from "@/lib/rarity";
import { cn } from "@/lib/utils";

/**
 * A rarity, as a 6px gem — and, for anyone who cannot see it, as a word.
 *
 * The gem alone is colour-only information, which is why every call site had grown its own
 * `sr-only` label or its own `title`. One component, one accessible name, four call sites:
 * the search table, the art grid, the card pane and the collection table.
 *
 * Never a filled badge: the direction's colour budget is spent on mana and card art, and a
 * mythic-orange pill would out-shout the art it annotates.
 */
export function RarityGem({
  rarity,
  withLabel = false,
  className,
}: {
  rarity: string | null;
  /** Print the word beside the gem, tinted. Tables do; tiles do not. */
  withLabel?: boolean;
  className?: string;
}) {
  const color = rarityColor(rarity);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <span
        aria-hidden="true"
        className="size-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: color }}
      />
      {/* The word is the accessible name whether or not it is drawn: a gem with no text is
          a colour, and a colour is not information anyone can be required to see. */}
      <span
        className={cn("truncate capitalize", withLabel ? "text-dim" : "sr-only")}
        style={withLabel && rarity ? { color } : undefined}
      >
        <span className="sr-only">Rarity: </span>
        {rarity ?? "unknown"}
      </span>
    </span>
  );
}
```

and `src/components/FilterChips.tsx`, holding what `FilterBar` had inline so the collection's filter row is the same row rather than a lookalike: `FILTER_FOCUS`, `FILTER_CONTROL`, `ManaChip` (moved verbatim from `FilterBar.tsx`, including its comments about the 60% dim and the offset ring), `ManaValueChips` (the 0–8+ row, `MANA_VALUES` moved here from `useCardSearch.ts` and re-exported there for its existing importers), `ToggleChip` (a labelled on/off chip — new, used by "Owned" and by the collection's finish/condition filters), and `ResetAll` (the button with the count badge). `FilterBar.tsx` then imports all five and keeps its own layout; **its existing tests must pass unedited**, which is the check that the extraction changed nothing.

- [ ] **Step 8: Mirror the new commands** — in `src/lib/ipc.ts`, add the DTOs (field-for-field against `collection.rs`, `wishlist.rs` and `search.rs`, which is what the Rust-side shape tests pin), the two new `CardSummary` fields, `owned` on `SearchRequest`, and the commands:

```ts
  /** Add copies. The same printing, finish and condition twice is one row with a bigger
   *  number — the backend upserts on the grain. */
  collectionAdd: (entry: EntryInput) => invoke<EntryChange>("collection_add", { entry }),
  /** An absolute quantity. `0` removes the row, and says so in `removed`. */
  collectionSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("collection_set_quantity", { id, quantity }),
  collectionUpdate: (id: number, patch: EntryPatch) =>
    invoke<EntryChange>("collection_update", { id, patch }),
  collectionRemove: (id: number) => invoke<EntryChange>("collection_remove", { id }),
  collectionList: (query: CollectionQuery) => invoke<CollectionPage>("collection_list", { query }),
  /** The aggregate header, over the same filters as the list it captions. */
  collectionSummary: (query: CollectionQuery) =>
    invoke<CollectionSummary>("collection_summary", { query }),
  wishlistAdd: (wish: WishInput) => invoke<EntryChange>("wishlist_add", { wish }),
  wishlistSetQuantity: (id: number, quantity: number) =>
    invoke<EntryChange>("wishlist_set_quantity", { id, quantity }),
  wishlistRemove: (id: number) => invoke<EntryChange>("wishlist_remove", { id }),
  wishlistList: (query: WishlistQuery) => invoke<WishlistPage>("wishlist_list", { query }),
```

and extend `src/lib/ipc.test.ts`'s argument-name table with all eight, because `invoke` matches by name and a typo there is a runtime rejection nothing else would catch.

- [ ] **Step 9: The store** — in `src/lib/store.ts`, add the collection's own layout toggle (the search's is not shared: a reader can want art in one view and a table in the other):

```ts
  /** How the collection is laid out. Separate from `searchView` on purpose — the search is
   *  for looking at cards, the collection is usually for counting them. */
  collectionView: SearchView;
  setCollectionView: (view: SearchView) => void;
```
with `collectionView: "table"` as the default, and `setActiveView` continuing to clear `selectedCardId`.

- [ ] **Step 10: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: collection IPC types, finish and condition vocabularies, shared filter chrome

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Add to collection — the quick-add popup and its three entry points

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** This popup is the first new dismissible layer since the set picker; it follows the Escape handshake (`"inner"`, capture phase, `preventDefault`) or it will close the card pane it is standing in.

Spec §7: *"Right-click/hover actions everywhere: add to collection (with finish/condition quick-pick), add to wishlist."* One popup serves all three surfaces — the detail pane's printings rows (the carryover fold that asked for them to become an entry point), the art grid's tiles, and the search table's rows.

**Files:**
- Create: `src/components/QuantityStepper.tsx` + `.test.tsx`, `src/features/collection/AddToCollection.tsx` + `.test.tsx`
- Modify: `src/features/card/CardDetailPane.tsx` (+ test), `src/features/search/CardGrid.tsx` (+ test), `src/features/search/SearchPage.tsx` (+ test)

**Interfaces:**
- Produces:

```tsx
// src/components/QuantityStepper.tsx
export function QuantityStepper(props: {
  value: number; onChange: (next: number) => void;
  min?: number; max?: number; label: string; size?: "sm" | "md";
}): JSX.Element;

// src/features/collection/AddToCollection.tsx
export interface AddTarget {
  cardId: string; name: string; setCode: string; collectorNumber: string;
  oracleId: string | null; finishes: Finish[];
}
export function AddToCollectionButton(props: { target: AddTarget; className?: string }): JSX.Element;
```

- [ ] **Step 1: Write the failing component tests** — create `src/features/collection/AddToCollection.test.tsx` covering, with `@testing-library/user-event` and a mocked `@/lib/ipc` (the pattern `CardDetailPane.test.tsx` already uses):

1. **the default add is one nonfoil near-mint copy** — open the popup, press "Add to collection", and assert `ipc.collectionAdd` was called with exactly `{ cardId, finish: "nonfoil", condition: "NM", quantity: 1 }`;
2. **only the finishes the printing exists in are offered** — a target with `finishes: ["nonfoil","foil"]` shows two finish chips and no etched one;
3. **the popup is an `"inner"` Escape layer** — pressing Escape closes the popup and *not* the card pane around it (assert `preventDefault` was called on the event and the pane's `onClose` was not);
4. **focus goes back to the button that opened it**, before the popup unmounts;
5. **the wishlist tab offers "this printing" and "any printing"**, and "any printing" sends `{ oracleId, name }` with no `cardId`;
6. **a failed add says so and keeps the popup open** — the mutation rejects with the backend's busy sentence and it is rendered in a `role="alert"`, with the form still filled in;
7. **a successful add reports in a `role="status"`** ("Added 2 × Lightning Bolt") and leaves the popup open for a second add, because adding three conditions of the same card is one interaction, not three.

- [ ] **Step 2: Run them and watch them fail**

```powershell
npm run test:run -- AddToCollection
```

- [ ] **Step 3: Write the stepper** — `src/components/QuantityStepper.tsx`:

```tsx
import { Minus, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

const BUTTON =
  "grid place-items-center rounded-md border border-border text-dim transition-colors " +
  "duration-150 hover:text-text disabled:opacity-40 disabled:hover:text-dim " +
  "motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 " +
  "focus-visible:outline-accent";

/**
 * A quantity, and the two buttons that change it.
 *
 * The number is an `<input type="number">` rather than a label: typing `12` is one action
 * and pressing `+` eleven times is eleven, and a collection is full of twelves. It is
 * `font-mono tabular-nums` because a quantity is data — the direction reserves colour for
 * mana and art, so this control is grey, and its only emphasis is the focus outline.
 */
export function QuantityStepper({
  value,
  onChange,
  min = 0,
  max = 9999,
  label,
  size = "md",
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  max?: number;
  /** The accessible name of the number itself — "Quantity of Lightning Bolt", not "Quantity". */
  label: string;
  size?: "sm" | "md";
}) {
  const box = size === "sm" ? "size-7" : "size-9";
  const field = size === "sm" ? "h-7 w-12 text-xs" : "h-9 w-14 text-sm";
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        aria-label={`Decrease ${label}`}
        disabled={value <= min}
        onClick={() => onChange(clamp(value - 1))}
        className={cn(BUTTON, box)}
      >
        <Minus className="size-3.5" aria-hidden="true" />
      </button>
      <input
        type="number"
        inputMode="numeric"
        aria-label={label}
        value={value}
        min={min}
        max={max}
        onChange={(e) => {
          // An empty box is a box being typed in, not a zero — clamping it to `min` on
          // every keystroke makes it impossible to replace "1" with "12".
          const next = Number.parseInt(e.target.value, 10);
          if (Number.isNaN(next)) return;
          onChange(clamp(next));
        }}
        className={cn(
          "rounded-md border border-border bg-surface text-center font-mono tabular-nums",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          field,
        )}
      />
      <button
        type="button"
        aria-label={`Increase ${label}`}
        disabled={value >= max}
        onClick={() => onChange(clamp(value + 1))}
        className={cn(BUTTON, box)}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}
```

- [ ] **Step 4: Write the popup** — `src/features/collection/AddToCollection.tsx`:

```tsx
import { useCallback, useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { QuantityStepper } from "@/components/QuantityStepper";
import { FINISH_LABEL, type Finish } from "@/lib/finish";
import { ipc, ipcError } from "@/lib/ipc";
import { useDismissOnEscape } from "@/lib/useDismissOnEscape";
import { cn } from "@/lib/utils";
import { CONDITIONS, CONDITION_LABEL, type Condition } from "./conditions";

/** The printing a quick-add is about. Every surface that shows a card can build one. */
export interface AddTarget {
  cardId: string;
  name: string;
  setCode: string;
  collectorNumber: string;
  /** For an "any printing" wish. `null` on a reversible card, which has no oracle id. */
  oracleId: string | null;
  /** The finishes this printing exists in. Empty means "unknown", and nonfoil is offered. */
  finishes: Finish[];
}

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const CHIP =
  "rounded-md border px-2 py-1 text-xs transition-colors duration-150 motion-reduce:transition-none";

/**
 * The "+" that adds a card, and the popup behind it.
 *
 * One component for all three surfaces (printings row, art tile, table row) because the
 * decision being made is the same one every time: which finish, what condition, how many —
 * and the direction's rule that a control means the same thing wherever it appears is
 * cheaper to keep than to restore.
 */
export function AddToCollectionButton({
  target,
  className,
}: {
  target: AddTarget;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Escape hands the caret back before React unmounts the popup — an element that
  // disappears with focus on it drops the caret to `<body>`, and the next Tab restarts from
  // the top of the app.
  const dismiss = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  return (
    <span className={cn("relative inline-flex", className)}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`Add ${target.name} (${target.setCode.toUpperCase()} ${target.collectorNumber}) to collection`}
        className={cn(
          "grid size-6 place-items-center rounded-md border border-border text-dim",
          "transition-colors duration-150 hover:text-text motion-reduce:transition-none",
          FOCUS,
        )}
      >
        <Plus className="size-3.5" aria-hidden="true" />
      </button>
      {open && <AddPopup target={target} onDismiss={dismiss} onClose={() => setOpen(false)} />}
    </span>
  );
}

function AddPopup({
  target,
  onDismiss,
  onClose,
}: {
  target: AddTarget;
  /** Escape: close *and* hand focus back. */
  onDismiss: () => void;
  /** Outside click: close only — the reader is already somewhere else. */
  onClose: () => void;
}) {
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const finishes = target.finishes.length > 0 ? target.finishes : (["nonfoil"] as Finish[]);
  const [mode, setMode] = useState<"collection" | "wishlist">("collection");
  const [finish, setFinish] = useState<Finish>(finishes[0]);
  const [condition, setCondition] = useState<Condition>("NM");
  const [quantity, setQuantity] = useState(1);
  const [anyPrinting, setAnyPrinting] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const queryClient = useQueryClient();

  // The innermost open layer: capture phase, and the press is consumed so the card detail
  // pane underneath does not close on the same one. See `useDismissOnEscape` — and note
  // that two "inner" peers are *not* ordered by it, so this popup and the set picker must
  // never be open at once (they cannot be: they live in different views).
  useDismissOnEscape({ layer: "inner", onDismiss });

  const add = useMutation({
    mutationFn: () =>
      mode === "collection"
        ? ipc.collectionAdd({
            cardId: target.cardId,
            finish,
            condition,
            quantity,
          })
        : ipc.wishlistAdd(
            anyPrinting
              ? {
                  oracleId: target.oracleId,
                  name: target.name,
                  quantity,
                  preferredFinish: finish,
                }
              : { cardId: target.cardId, quantity, preferredFinish: finish },
          ),
    onSuccess: () => {
      setDone(
        `${quantity} × ${target.name} added to your ${mode === "collection" ? "collection" : "wishlist"}.`,
      );
      // Everything that counts cards: the two lists, their summary, and the search results
      // that badge what is owned.
      void queryClient.invalidateQueries({ queryKey: ["collection"] });
      void queryClient.invalidateQueries({ queryKey: ["wishlist"] });
      void queryClient.invalidateQueries({ queryKey: ["cards", "search"] });
    },
  });

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={`Add ${target.name}`}
      // Anchored, not portalled: the shipped CSP is `style-src 'self'` and every overlay
      // primitive in reach injects a runtime <style> the moment it opens (fine under
      // `tauri dev`, blank in a packaged build). Same decision as `SetCombobox`.
      className="absolute right-0 top-7 z-20 w-64 space-y-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
      onBlur={(e) => {
        // Closing on focus leaving the popup covers the click-outside case as well, and
        // does it without a window listener that could fight the Escape handshake.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onClose();
      }}
    >
      <div role="group" aria-label="Add to" className="flex gap-1">
        {(["collection", "wishlist"] as const).map((m) => (
          <button
            key={m}
            type="button"
            aria-pressed={mode === m}
            onClick={() => setMode(m)}
            className={cn(
              CHIP,
              "flex-1 capitalize",
              mode === m ? "border-accent text-accent" : "border-border text-dim hover:text-text",
            )}
          >
            {m}
          </button>
        ))}
      </div>

      <div role="group" aria-label="Finish" className="flex flex-wrap gap-1">
        {finishes.map((f) => (
          <button
            key={f}
            type="button"
            aria-pressed={finish === f}
            onClick={() => setFinish(f)}
            className={cn(
              CHIP,
              finish === f ? "border-accent text-accent" : "border-border text-dim hover:text-text",
            )}
          >
            {FINISH_LABEL[f]}
          </button>
        ))}
      </div>

      {mode === "collection" ? (
        <div className="space-y-1">
          <label htmlFor={`${id}-condition`} className="text-xs text-dim">
            Condition
          </label>
          <select
            id={`${id}-condition`}
            value={condition}
            onChange={(e) => setCondition(e.target.value as Condition)}
            className={cn(
              "h-9 w-full rounded-md border border-border bg-surface px-2 text-sm",
              FOCUS,
            )}
          >
            {CONDITIONS.map((c) => (
              <option key={c} value={c}>
                {CONDITION_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <div role="group" aria-label="Which printing" className="flex gap-1">
          {[
            { any: false, label: "This printing" },
            { any: true, label: "Any printing" },
          ].map(({ any, label }) => (
            <button
              key={label}
              type="button"
              aria-pressed={anyPrinting === any}
              // A wish for "any printing" is keyed on the oracle card, and a reversible
              // card has none — so the choice is simply not offered where it cannot be kept.
              disabled={any && target.oracleId === null}
              onClick={() => setAnyPrinting(any)}
              className={cn(
                CHIP,
                "flex-1 disabled:opacity-40",
                anyPrinting === any
                  ? "border-accent text-accent"
                  : "border-border text-dim hover:text-text",
              )}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2">
        <QuantityStepper
          value={quantity}
          onChange={setQuantity}
          min={1}
          size="sm"
          label={`Quantity of ${target.name}`}
        />
        <button
          type="button"
          onClick={() => add.mutate()}
          disabled={add.isPending}
          className={cn(
            "h-7 rounded-md border border-accent px-2 text-xs text-accent",
            "transition-colors duration-150 hover:bg-accent hover:text-accent-foreground",
            "disabled:opacity-50 motion-reduce:transition-none",
            FOCUS,
          )}
        >
          {add.isPending ? "Adding…" : "Add"}
        </button>
      </div>

      {add.isError && (
        <p role="alert" className="text-xs text-destructive">
          {ipcError(add.error)}
        </p>
      )}
      {/* Stays open after a success: recording two conditions of the same card is one
          interaction, and a popup that closed itself would make it two. */}
      {done && !add.isError && (
        <p role="status" className="text-xs text-dim">
          {done}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire the three entry points**

**Printings rows** (`CardDetailPane.tsx`): `PrintingRow` gains a trailing `<AddToCollectionButton>` built from the printing's own fields, and the row becomes `flex items-center` so the button lines up with the prices. This is the carryover fold — the rows are now the fastest way to record "I have the Alpha one".

**Art tiles** (`CardGrid.tsx`): the tile is currently one `<button>`, and a button inside a button is invalid HTML that React will warn about and browsers will render unpredictably. Restructure: the wrapper becomes a `<div className="group relative flex flex-col gap-1">`, the *art* stays a `<button>` that opens the card, and the caption row carries the `<AddToCollectionButton>` beside the set/number. The add button is `opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100` so a wall of art is not a wall of plus signs — but it is always in the tab order, because "visible on hover" is not a state a keyboard has.

**Table rows** (`SearchPage.tsx`): the `GRID` template gains a sixth, 2.5rem column at the end; the cell holds the button, with `onClick={(e) => e.stopPropagation()}` on its wrapper so adding a card does not also open it. The header row gets a matching empty `columnheader` with an `sr-only` "Actions" label.

Each of the three passes `finishes` from what it has: the printings row and the pane have the printing's `finishes` blob (`parseFinishes`), the grid and table have none on `CardSummary` — so they pass `[]`, and the popup offers nonfoil. That is the honest default: `finishes` is not on the search DTO, and adding it there to save one chip would put a JSON blob on every row of a 116 k-row browse.

- [ ] **Step 6: Run the affected suites**

```powershell
npm run test:run -- AddToCollection QuantityStepper CardDetailPane CardGrid SearchPage App
```
Expected: green, including `App.test.tsx`'s Escape-stack test — which now has a third layer in play and is the reason the popup is `"inner"`.

- [ ] **Step 7: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: quick-add to collection and wishlist from every card surface

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: The Collection view

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.** The aggregate header is the one new *composition* in this plan: it is data, so it is Geist Mono and quiet, and the only colour on the screen is the card art below it.

Spec §7: *"Virtualized grid/table of owned cards with the same filters + sort by name/set/price/date-added/quantity. Inline quantity steppers per finish/condition row. Aggregate header: total cards, unique cards, estimated value (USD/EUR, as-of date)."* The sidebar placeholder becomes the real view.

**Files:**
- Create: `src/features/collection/useCollection.ts` + `.test.ts`, `src/features/collection/CollectionPage.tsx` + `.test.tsx`, `src/features/collection/CollectionSummary.tsx`, `src/features/collection/CollectionTable.tsx`, `src/features/collection/CollectionFilterBar.tsx`
- Modify: `src/App.tsx`, `src/features/search/CardGrid.tsx` (make the tile row generic + badge slot)

**Interfaces:**
- Produces:

```ts
// src/features/collection/useCollection.ts
export const COLLECTION_PAGE_SIZE = 100;
export const COLLECTION_SORTS: readonly { value: string; label: string }[];
export function useCollection(): {
  text, setText, format, setFormat, colors, toggleColor, sets, toggleSet,
  manaValues, toggleManaValue, finishes, toggleFinish, conditions, toggleCondition,
  needsReview, setNeedsReview, sort, setSort, activeCount, resetAll,
  query,            // useInfiniteQuery over ipc.collectionList
  summary,          // useQuery over ipc.collectionSummary, same filters
  rows: CollectionRow[], total: number, queryKeyString: string,
};
```

- `CardGrid` is generalised: its `rows` prop becomes `GridCard[]` (`{ id, name, setCode, collectorNumber, rarity }`), which `CardSummary` satisfies structurally, plus an optional `badge?: (card: GridCard) => ReactNode` rendered over the art's bottom-left corner. Nothing about the search's use changes.

- [ ] **Step 1: Write the failing tests** — `src/features/collection/useCollection.test.ts` for the pure parts (`activeFilterCount` over the collection's larger filter set; `resetAll` clearing all seven; the query key changing when a finish filter toggles and *not* when the same two finishes are picked in the other order), and `CollectionPage.test.tsx` for:

1. **an empty collection explains itself** — "Nothing here yet. Add cards from search, or import a collection file." rather than "no cards match", which would blame the reader for an empty table;
2. **the summary header renders the four figures** and labels the value with `PRICES_AS_OF`;
3. **the unpriced count is shown when it is non-zero** — "1 240 cards · 2 unpriced";
4. **a stepper writes through** — pressing `+` on a row calls `ipc.collectionSetQuantity(id, 3)` and the row's number follows;
5. **setting a quantity to zero removes the row from the list** without a refetch round trip being required to hide it;
6. **the needs-review banner appears when `summary.needsReview > 0`**, names the count, and its button switches the list to those rows;
7. **the flagged row renders its reason** and still shows `SET · NUMBER` from the denormalized columns even with `name: null`.

- [ ] **Step 2: Run them and watch them fail**

```powershell
npm run test:run -- Collection useCollection
```

- [ ] **Step 3: Write `useCollection`** — the same shape as `useCardSearch` (debounced text, one query key built from every input, `keepPreviousData`), plus:

```ts
  // The summary is its own query over the *same* filters, not a field of the page: a
  // header that describes a different set of rows than the table under it is worse than no
  // header, and recomputing nine aggregates on every scroll page would be worse still.
  const summary = useQuery({
    queryKey: ["collection", "summary", filterKey],
    queryFn: () => ipc.collectionSummary(filters),
  });
```

with `queryKey: ["collection", "list", filterKey]` for the paged list, so the popup's `invalidateQueries({ queryKey: ["collection"] })` refreshes both.

- [ ] **Step 4: Write the summary header** — `src/features/collection/CollectionSummary.tsx`:

```tsx
import type { CollectionSummary as Summary } from "@/lib/ipc";
import { eurPrice, PRICES_AS_OF, usdPrice } from "@/lib/prices";

/**
 * What the collection adds up to.
 *
 * Four figures, in the data face, with no colour and no chrome: the direction spends its
 * boldness on card art, and a row of tinted stat cards above a wall of Magic art is two
 * things shouting. The value carries its as-of sentence because spec §5 requires every
 * price on screen to say how old it is — and the unpriced count sits beside it because a
 * total that silently omits 200 cards is a number that lies by rounding down.
 */
export function CollectionSummaryHeader({ summary }: { summary: Summary | undefined }) {
  const n = (value: number) => value.toLocaleString("en-US");
  return (
    <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-2 border-b border-border pb-3">
      <Figure label="Cards" value={summary ? n(summary.totalCards) : "—"} />
      <Figure label="Unique" value={summary ? n(summary.uniqueCards) : "—"} />
      <Figure
        label="Value (USD)"
        value={summary ? usdPrice(summary.valueUsd) : "—"}
        note={summary && summary.unpricedUsd > 0 ? `${n(summary.unpricedUsd)} unpriced` : undefined}
        title={PRICES_AS_OF}
      />
      <Figure
        label="Value (EUR)"
        value={summary ? eurPrice(summary.valueEur) : "—"}
        // Etched printings have no EUR price in Scryfall's data at all — `eur_etched` is
        // documented and absent — so they are unpriced here rather than valued at the
        // nonfoil rate.
        note={summary && summary.unpricedEur > 0 ? `${n(summary.unpricedEur)} unpriced` : undefined}
        title={PRICES_AS_OF}
      />
      {summary && summary.tradelistCards > 0 && (
        <Figure label="For trade" value={n(summary.tradelistCards)} />
      )}
    </dl>
  );
}

function Figure({
  label,
  value,
  note,
  title,
}: {
  label: string;
  value: string;
  note?: string;
  title?: string;
}) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-xs text-dim">{label}</dt>
      <dd className="font-mono text-lg tabular-nums">
        {value}
        {note && <span className="ml-2 text-xs text-dim">{note}</span>}
      </dd>
    </div>
  );
}
```

- [ ] **Step 5: Write the table and the page** — `CollectionTable.tsx` is `SearchPage`'s virtualized table with the collection's columns (name + mana cost · set · finish/condition · quantity stepper · unit price · value) and the same sticky-header-inside-the-scroller trick, `role="table"`/`aria-rowcount`, `ROW_FOCUS` outline and `RarityGem`. Two things are new:

```tsx
        {/* The stepper writes straight through: a collection table is where quantities are
            *maintained*, and making the reader open an editor to change a 3 to a 4 is the
            difference between a tool and a form. The mutation is optimistic on the row's
            own number only — the summary above re-fetches, because a wrong total is a
            worse lie than a slow one. */}
        <QuantityStepper
          size="sm"
          value={row.quantity}
          min={0}
          label={`Quantity of ${row.name ?? row.cardId} (${FINISH_LABEL[finish]}, ${row.condition})`}
          onChange={(next) => setQuantity.mutate({ id: row.id, quantity: next })}
        />
```

```tsx
      {row.needsReview && (
        // Not a colour-only signal and not a destructive one: the card is still owned, and
        // the row says what happened in the same sentence the reconciler wrote.
        <p className="col-span-full px-3 pb-1 text-[0.7rem] text-dim">
          <span className="mr-1 font-medium text-destructive">Needs review:</span>
          {row.needsReview}
        </p>
      )}
```

`CollectionPage.tsx` composes: `<h2>` (Cinzel, the view title the ribbon also names), `CollectionSummaryHeader`, the needs-review banner, `CollectionFilterBar` (the shared chips plus finish and condition `ToggleChip`s and a sort `<select>` over `COLLECTION_SORTS`), the layout toggle bound to `store.collectionView`, and then either `CollectionTable` or `CardGrid` with a quantity badge:

```tsx
        <CardGrid
          rows={rows.map((r) => ({
            id: r.cardId,
            name: r.name ?? `${r.setCode.toUpperCase()} ${r.collectorNumber}`,
            setCode: r.setCode,
            collectorNumber: r.collectorNumber,
            rarity: r.rarity,
          }))}
          badge={(card) => <QuantityBadge rows={rows} cardId={card.id} />}
          searchKey={queryKeyString}
          selectedId={selectedCardId}
          onSelect={selectCard}
          onNeedNextPage={fetchNextPage}
        />
```

- [ ] **Step 6: Mount it** — in `src/App.tsx`, `ActiveView` returns `<CollectionPage />` for `"collection"`, and `BLURB` loses its `collection` entry (the remaining three keep theirs, so the `Record<Exclude<ViewId, "search" | "collection">, string>` type changes with it).

- [ ] **Step 7: Run and verify**

```powershell
npm run test:run -- Collection CardGrid App
npm run verify
```

- [ ] **Step 8: Commit**

```powershell
git add -A
git commit -m "feat: the collection view - aggregates, filters, inline steppers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: The Wishlist view, and owned badges in search

> **Invoke the `frontend-design` skill before writing any of this task; `docs/superpowers/specs/2026-08-04-visual-design-direction.md` is binding — execute it, don't invent.**

Spec §7: *"Wishlist view mirrors this; 'owned' badges appear in search once a wish is fulfilled."* The mirror is deliberately thinner — a wishlist is a shopping list, not an inventory — and the badge closes the loop back into search.

**Files:**
- Create: `src/features/wishlist/useWishlist.ts`, `src/features/wishlist/WishlistPage.tsx` + `.test.tsx`
- Modify: `src/App.tsx`, `src/features/search/SearchPage.tsx`, `src/features/search/CardGrid.tsx`, `src/features/search/FilterBar.tsx`, `src/features/search/useCardSearch.ts`

- [ ] **Step 1: Write the failing tests** — `WishlistPage.test.tsx`:

1. **a wish shows what is still needed** — `quantity: 4`, `ownedQuantity: 1` renders "1 of 4 owned" and a progress-free mono readout (no bar: the motion and colour budget is spent);
2. **a fulfilled wish is marked, not hidden** — `ownedQuantity >= quantity` renders "Fulfilled" and stays in the list, because a wishlist that deletes its own entries loses the record of why they were there;
3. **the "still missing" filter** narrows to unfulfilled wishes;
4. **an any-printing wish says so** — "Any printing" where a pinned one shows `SET · NUMBER`;
5. **the desired-quantity stepper writes through** `ipc.wishlistSetQuantity`;
6. **the total cost line** sums `unitPriceUsd × (quantity − owned)` and carries `PRICES_AS_OF`.

and in `SearchPage.test.tsx` / `CardGrid.test.tsx`: **a result the user owns carries a mono `×3` badge with an accessible name ("3 in your collection"), and a wished card carries a heart with "On your wishlist"** — and neither appears on a card with `ownedQuantity: 0, wishlisted: false`.

- [ ] **Step 2: Run them and watch them fail**

```powershell
npm run test:run -- Wishlist SearchPage CardGrid
```

- [ ] **Step 3: Write the wishlist view** — `useWishlist.ts` mirrors `useCollection` over `ipc.wishlistList` with the `fulfilled` filter, and `WishlistPage.tsx` is a single virtualized list (no grid toggle: a shopping list is read by name, not by art) whose row is:

```tsx
      <span role="cell" className="flex min-w-0 items-baseline gap-2">
        <span className="truncate">{row.name}</span>
        <ManaText source={row.manaCost} className="shrink-0 text-xs" />
      </span>
      <span role="cell" className="truncate font-mono text-xs text-dim">
        {/* The distinction spec §6 draws in one word, said in two. */}
        {row.cardId
          ? `${row.setCode?.toUpperCase() ?? "—"} · ${row.collectorNumber ?? "—"}`
          : "Any printing"}
      </span>
      <span role="cell" className="font-mono text-xs tabular-nums text-dim">
        {row.ownedQuantity >= row.quantity
          ? "Fulfilled"
          : `${row.ownedQuantity} of ${row.quantity} owned`}
      </span>
```

- [ ] **Step 4: Badge the search results** — `CardGrid`'s tile renders `badge` (added in Task 11) over the art's bottom-left corner, and `SearchPage` passes one built from the new `CardSummary` fields:

```tsx
/**
 * What the reader already has, said on the card itself.
 *
 * A quantity is data, so it is mono on a plain surface — no green, no "owned" pill. The
 * heart is `lucide`'s, filled only when the wish is real, and both carry their meaning in
 * an accessible name because a badge that only exists as a shape is not a badge for
 * everyone.
 */
function OwnedBadge({ owned, wishlisted }: { owned: number; wishlisted: boolean }) {
  if (owned === 0 && !wishlisted) return null;
  return (
    <span className="pointer-events-none absolute bottom-1 left-1 flex items-center gap-1 rounded-md bg-bg/85 px-1.5 py-0.5 font-mono text-[0.7rem] tabular-nums">
      {owned > 0 && (
        <>
          <span aria-hidden="true">×{owned}</span>
          <span className="sr-only">{owned} in your collection</span>
        </>
      )}
      {wishlisted && (
        <>
          <Heart className="size-3" aria-hidden="true" />
          <span className="sr-only">On your wishlist</span>
        </>
      )}
    </span>
  );
}
```

The table row shows the same two facts inside its name cell, so the two views state one truth the same way.

- [ ] **Step 5: The Owned filter chip** — `useCardSearch` gains `owned: boolean | undefined` with a three-state toggle (any → owned → missing → any), counted by `activeFilterCount` and cleared by `resetAll`; `FilterBar` renders it with the shared `ToggleChip`. The request sends `owned` only when it is set, so an untouched filter row still produces the same payload it always did.

- [ ] **Step 6: Mount it** — `App.tsx` returns `<WishlistPage />` for `"wishlist"`, and `BLURB` drops that entry too (leaving `decks` and `settings`).

- [ ] **Step 7: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: the wishlist view, and owned badges back in search

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Image work — single-flight fetches, a size cap, and a pre-warm for what the user owns

Carryover items 3, 6, 7, and the half of spec §5's pre-warm that has data at last: *"a resumable background job keeps images for all collection/wishlist/deck cards cached … so the user's own cards browse fully offline."*

**Files:**
- Modify: `src-tauri/src/images.rs`, `src-tauri/src/scryfall.rs`, `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/features/collection/CollectionPage.tsx`

**Interfaces:**
- Produces:

```rust
// src-tauri/src/scryfall.rs
/// The largest image body this app will read.
pub const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

// src-tauri/src/images.rs
/// Images one pre-warm pass will fetch. Resumable across sessions by construction.
pub const MAX_PREWARM: usize = 2_000;
pub fn prewarm_keys(conn: &Connection, variant: Variant, limit: usize) -> rusqlite::Result<Vec<ImageKey>>;
#[tauri::command] pub async fn prewarm_collection(state: …) -> Result<usize, String>;
```

- [ ] **Step 1: Write the failing tests** — append to `src-tauri/src/images.rs`'s `mod tests`:

```rust
    /// Carryover item 3, ledgered twice: nothing deduplicated two requests for the same
    /// key in flight at once, so a tile and its own prefetch — or two prefetch loops from
    /// two pages that landed together — could each spend a permit, a 100 ms slot and a
    /// round trip on the same bytes. One fetch per key, and the second caller reads what
    /// the first one wrote.
    #[tokio::test]
    async fn two_requests_for_one_image_make_one_round_trip() {
        const CARD: &str = "0000419b-0bba-4488-8f7a-6194544ce91d";
        let server = MockServer::start();
        let mock = server.mock(|when, then| {
            when.method(GET).path("/grid/front/0/0/x.webp");
            then.status(200)
                .header("content-type", "image/webp")
                .body(b"webp-bytes");
        });
        let f = Fixture::new("single-flight");
        f.card(CARD, &format!("{}/grid/front/0/0/x.webp?17", server.base_url()));
        let client = scryfall::Client::new(server.base_url());
        let key = ImageKey {
            card_id: CARD.into(),
            face: 0,
            variant: Variant::Grid,
        };

        // Both start before either can have finished, which is the race a tile and its own
        // prefetch run every time a page lands.
        let (a, b) = tokio::join!(
            f.cache.get(&client, &f.read, &f.write, &key),
            f.cache.get(&client, &f.read, &f.write, &key),
        );

        assert_eq!(a.unwrap().bytes, b"webp-bytes");
        assert_eq!(b.unwrap().bytes, b"webp-bytes", "the waiter reads what the fetcher wrote");
        mock.assert_hits(1);
    }

    /// Carryover item 7: `fetch_image` now has a production caller and points at a host
    /// that can serve whatever it likes. The largest variant this app stores is ~93 KB;
    /// a body that claims to be gigabytes is refused before it is read, not after.
    #[tokio::test]
    async fn an_oversized_image_body_is_refused_before_it_is_read() {
        let server = MockServer::start();
        server.mock(|when, then| {
            when.method(GET).path("/huge.webp");
            then.status(200)
                .header("content-length", (crate::scryfall::MAX_IMAGE_BYTES + 1).to_string())
                .body(vec![0u8; 32]);
        });
        let client = crate::scryfall::Client::new(server.base_url());

        let err = client
            .fetch_image(&format!("{}/huge.webp?17", server.base_url()))
            .await
            .unwrap_err();

        assert!(err.to_string().contains("too large"), "{err}");
    }

    /// Spec §5's pre-warm, scoped to what the user owns rather than to the database — 116 k
    /// `grid` images would be ~7 GB. Resumable by construction: a key already in
    /// `image_cache` is not selected, so the next pass picks up where this one stopped.
    #[test]
    fn the_prewarm_selects_owned_cards_that_are_not_cached_yet() {
        let conn = seeded();
        conn.execute(
            "INSERT INTO collection_entries
                (card_id,set_code,collector_number,lang,finish,condition,quantity,created_at,updated_at)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d','lea','161','en','nonfoil','NM',1,
                     unixepoch(),unixepoch())",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO wishlist_entries (oracle_id,card_id,name,quantity,created_at,updated_at)
             VALUES ('o1','11111111-1111-4111-8111-111111111111','Wanted',1,unixepoch(),unixepoch())",
            [],
        )
        .unwrap();

        let keys = prewarm_keys(&conn, Variant::Grid, 100).unwrap();
        assert_eq!(keys.len(), 2, "owned and wished, front faces only");
        assert!(keys.iter().all(|k| k.face == 0 && k.variant == Variant::Grid));

        // Once the bytes are on disk the key is not selected again — which is the whole of
        // "resumable", and it costs no bookkeeping of its own.
        conn.execute(
            "INSERT INTO image_cache (card_id, face, variant, source_uri, bytes, fetched_at)
             VALUES ('0000419b-0bba-4488-8f7a-6194544ce91d',0,'grid','https://x?1',10,unixepoch())",
            [],
        )
        .unwrap();
        assert_eq!(prewarm_keys(&conn, Variant::Grid, 100).unwrap().len(), 1);
    }
```

`Fixture` (`Fixture::new(name)`, `.cache`, `.read`, `.write`, `.card(id, uri)`) is the existing helper the fetch tests already use — a real file database with both connections and a real cache directory. `seeded()` is the in-memory `Connection` the resolution tests use.

- [ ] **Step 2: Run them and watch them fail**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml images
```

- [ ] **Step 3: Add the single-flight map** — in `src-tauri/src/images.rs`, `Cache` gains:

```rust
    /// One lock per key, so two callers who want the same image do not both fetch it.
    ///
    /// A `Mutex<HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>` rather than the shared
    /// *future* the carryover sketched: a `Shared<BoxFuture<…>>` has to be `'static`, which
    /// would mean an `Arc<Cache>` plus owned clones of the client and both connections
    /// threaded through the protocol handler. The second caller here waits on the key,
    /// then re-reads the disk — a 2 ms read instead of a shared buffer, for a fraction of
    /// the surface, and the network saving is identical.
    inflight: std::sync::Mutex<std::collections::HashMap<ImageKey, Arc<tokio::sync::Mutex<()>>>>,
```

with:

```rust
    /// The lock for one key, created if this is the first caller to ask.
    fn key_lock(&self, key: &ImageKey) -> Arc<tokio::sync::Mutex<()>> {
        let mut map = crate::sync::lock_plain(&self.inflight);
        Arc::clone(
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(()))),
        )
    }

    /// Drop the entry once nobody is holding it. Without this the map is a leak with a
    /// pleasant name: one entry per image the app has ever served.
    fn release_key(&self, key: &ImageKey) {
        let mut map = crate::sync::lock_plain(&self.inflight);
        if map.get(key).is_some_and(|l| Arc::strong_count(l) == 1) {
            map.remove(key);
        }
    }
```

and, in `get`, between the cache-hit check and the fetch:

```rust
        let bytes = {
            let lock = self.key_lock(key);
            let _held = lock.lock().await;
            // Someone may have fetched exactly these bytes while this call was waiting for
            // the key. Asking the disk again is cheaper than asking Scryfall, and it is the
            // whole payoff of having waited.
            let fresh = {
                let conn = crate::sync::lock_conn(read);
                is_current(&conn, key, &uri)
            };
            if fresh {
                if let Ok(bytes) = tokio::fs::read(&path).await {
                    self.release_key(key);
                    return Ok(Served { bytes, content_type: WEBP });
                }
            }
            self.fetch(client, &uri).await
        };
        self.release_key(key);
        let bytes = bytes?;
```

`ImageKey` becomes the map's key, so it and the `Variant` inside it both need the derives for one: `#[derive(Debug, Clone, PartialEq, Eq, Hash)]` on `ImageKey`, and `Hash` added to `Variant`'s existing `#[derive(Debug, Clone, Copy, PartialEq, Eq)]`. `sync::lock_plain` is a two-line sibling of `lock_conn` for a mutex that is not a `Connection`:

```rust
/// Lock any std mutex, recovering from poisoning — the same rule as [`lock_conn`], for the
/// maps and counters that are not connections.
pub(crate) fn lock_plain<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}
```

- [ ] **Step 4: Cap the body and log the off-host refusal** — in `scryfall.rs`:

```rust
/// The largest image body this app will read into memory.
///
/// The biggest variant it stores is `display` at ~93 KB, so this is two orders of magnitude
/// of headroom — it is not a budget, it is a refusal to let a host that is not the one we
/// think it is hand this process an arbitrary number of bytes. `fetch_image` has a
/// production caller now (every tile in the app), so "the CDN would not do that" is no
/// longer the only thing standing between here and a memory exhaustion.
pub const MAX_IMAGE_BYTES: u64 = 4 * 1024 * 1024;
```

```rust
            200 => {
                // The declared length first: refusing before the body is read is the only
                // check that costs nothing.
                if let Some(len) = resp.content_length() {
                    if len > MAX_IMAGE_BYTES {
                        return Err(ScryfallError::Unexpected(format!(
                            "image is too large: {len} bytes"
                        )));
                    }
                }
                let bytes = resp.bytes().await?;
                // And again after: `Content-Length` is a claim, and a chunked response
                // makes none at all.
                if bytes.len() as u64 > MAX_IMAGE_BYTES {
                    return Err(ScryfallError::Unexpected(format!(
                        "image is too large: {} bytes",
                        bytes.len()
                    )));
                }
                Ok(bytes.to_vec())
            }
```

and in `images.rs`'s `resolve`, on the refusal branch (carryover item 6):

```rust
        return Ok(if is_fetchable(&uri) {
            Resolution::Uri(uri)
        } else {
            // Once per process, not once per tile: a CDN move would make this true of every
            // image in the app, and forty thousand identical lines is not a signal. The
            // version rule is the common case and is silent — a `soon.jpg` is Scryfall
            // saying "no image", which the placeholder already says. An *off-host* URI is
            // different: it means the allowlist and Scryfall's data no longer agree, and
            // the symptom (every card shows "No image") looks nothing like the cause.
            if !is_image_host(&uri) && !(cfg!(test) && is_loopback(&uri)) {
                static WARNED: AtomicBool = AtomicBool::new(false);
                if !WARNED.swap(true, Ordering::Relaxed) {
                    eprintln!(
                        "image cache: refusing an image URI from an unexpected host \
                         (expected {IMAGE_HOST}…): {uri}"
                    );
                }
            }
            Resolution::Missing(Placeholder::NoImage)
        });
```

- [ ] **Step 5: Write the pre-warm** — in `images.rs`:

```rust
/// Images one pre-warm pass will fetch.
///
/// A pass, not a budget: keys already on disk are never selected, so a collection of ten
/// thousand cards warms over several sessions and each one starts where the last stopped.
/// At the measured 100 ms pacing this is a little over three minutes of background work.
pub const MAX_PREWARM: usize = 2_000;

/// The cards the user owns or wants, that have no cached image yet.
///
/// **`grid` only.** Spec §5 says `thumb` + `grid`; the app has no `thumb` surface yet (the
/// tables show no art), and fetching 9 KB per card for a view that does not exist is a
/// download rather than a pre-warm. When a list view with art lands, this is one more
/// variant in the call and nothing else.
pub fn prewarm_keys(
    conn: &Connection,
    variant: Variant,
    limit: usize,
) -> rusqlite::Result<Vec<ImageKey>> {
    let mut stmt = conn.prepare(
        "SELECT card_id FROM (
            SELECT card_id FROM collection_entries
            UNION
            SELECT card_id FROM wishlist_entries WHERE card_id IS NOT NULL)
          WHERE card_id NOT IN
                (SELECT card_id FROM image_cache WHERE variant = ?1 AND face = 0)
          LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![variant.key(), limit as i64], |r| {
        r.get::<_, String>(0)
    })?;
    Ok(rows
        .filter_map(Result::ok)
        .filter(|id| is_card_id(id))
        // Front faces only: the back of a double-faced card is not on screen until someone
        // opens the pane and flips it, and that fetch is one tile's worth.
        .map(|card_id| ImageKey {
            card_id,
            face: 0,
            variant,
        })
        .collect())
}

/// Warm the cache for what the user owns. Returns how many images were queued.
///
/// Fire-and-forget in the same sense as [`prefetch_images`]: it resolves when the work is
/// queued. The loop shares the cache's own semaphore and 100 ms gate with the live grid, so
/// a pre-warm running behind a browsing session competes for the same budget rather than
/// doubling it, and it abandons the batch on the first rate limit.
#[tauri::command]
pub async fn prewarm_collection(
    state: tauri::State<'_, std::sync::Arc<crate::sync::AppState>>,
) -> Result<usize, String> {
    let state = state.inner().clone();
    let keys = {
        let conn = crate::sync::lock_db_read(&state);
        prewarm_keys(&conn, Variant::Grid, MAX_PREWARM).map_err(|e| e.to_string())?
    };
    let queued = keys.len();
    tauri::async_runtime::spawn(async move {
        warm(&state.images, &state.client, &state.db_read, &state.db, keys).await;
    });
    Ok(queued)
}
```

Register the command, add `prewarmCollection: () => invoke<number>("prewarm_collection")` to `ipc.ts`, and call it once from `CollectionPage` on its first successful load:

```tsx
  // Once per session, on the first load that has rows: everything the user owns gets its
  // art cached in the background, so the collection browses without a network. Keys already
  // on disk are skipped by the query, which is what makes repeat calls cheap and the job
  // resumable across sessions.
  const warmed = useRef(false);
  useEffect(() => {
    if (warmed.current || rows.length === 0) return;
    warmed.current = true;
    void ipc.prewarmCollection().catch(() => {});
  }, [rows.length]);
```

- [ ] **Step 6: Verify and commit**

```powershell
npm run verify
git add -A
git commit -m "feat: single-flight image fetches, a body size cap, and a collection pre-warm

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: The small folds, CLAUDE.md, the live smoke, and the plan wrap

The remaining carryover folds, the documentation that makes the new invariants findable, and the measurements this plan claims but has not yet taken.

**Files:**
- Modify: `CLAUDE.md`, `src-tauri/src/sync.rs`, `src/lib/ipc.ts`, `src/components/Ribbon.tsx`, `src/lib/useDismissOnEscape.ts`, `docs/superpowers/notes/plan-3-carryover.md` (new)

- [ ] **Step 1: The `store_failures` consumer** — the counter has incremented since Plan 2 with nothing reading it. `sync::SyncStatus` gains `image_store_failures: u64` (read from `state.images.store_failures()`, which needs no database and so is always answered), `ipc.ts` mirrors it, and `Ribbon` appends one clause to the status line's tooltip when it is non-zero: *"N card images could not be saved to the cache — the data folder may be read-only or full."* Pin the new field in `dto_json_uses_the_camel_case_names_the_frontend_expects`.

- [ ] **Step 2: The `useDismissOnEscape` doc** — add the paragraph the carryover asked for:

```ts
 * **This does not generalise to two `"inner"` peers.** The protocol orders exactly two
 * rungs — one capture-phase layer and one bubble-phase layer — so two popups open at once
 * are not ordered by it at all: both would consume the same press and both would close. If
 * a third layer is ever needed, nest it deliberately (the inner one owns the press, the
 * middle one checks `defaultPrevented` before acting) or extend this hook with a depth,
 * rather than adding a second `"inner"` and hoping registration order holds.
```

- [ ] **Step 3: CLAUDE.md** — three edits, all of them things a future session needs before it reads any code:

Add to **Image cache**:

```md
- A card image URI with no `?<epoch>` cache-buster is **refused at resolution** — it is
  uncacheable by construction, so it resolves to the no-image placeholder and never to
  bytes (eight live printings publish `errors.scryfall.com/soon.jpg` in all four slots).
  `cards.scryfall.io` is the **only** host images are fetched from; an off-host URI is
  refused and warned about once per process. A placeholder is served `no-store` (it is the
  one 200 whose content is meant to change), real bytes `max-age=86400`.
```

Add a new **Hard rules — user data** section:

```md
## Hard rules — user data
- `collection_entries`/`wishlist_entries`/`card_migrations` reference `cards.id` **softly**
  and denormalize `set_code`/`collector_number`/`lang` (and `name`, on the wishlist). A row
  whose card vanishes is **flagged** (`needs_review`, a sentence) and never deleted —
  `reconcile::sweep_orphans` runs after every ingest and clears the flag if the card returns.
- Grain: `(card_id, finish, condition, lang, altered, signed, proxy, misprint, serial, grading)`,
  as `schema::COLLECTION_GRAIN` — one constant, because the UNIQUE index and every
  `ON CONFLICT` target must match verbatim. The `coalesce(…, '')`s are load-bearing: NULLs in
  a UNIQUE index are distinct.
- Finish is an **enum** (`nonfoil|foil|etched`), condition is one of `NM|LP|MP|HP|DMG`; both
  are CHECK-constrained in SQL *and* validated in Rust, and the imported string is kept in
  `condition_original`.
- **A finish's price is a lookup in the `prices` blob** (`usd`/`usd_foil`/`usd_etched`;
  `eur_etched` does not exist, so etched is unpriced in EUR). `cards.price_usd` is a
  sort/display fallback chain and must never be summed. `tix` is never summed with fiat.
- Writes take `AppState.db` through `db::lock_for(…, WRITE_LOCK_WAIT)` and answer
  `collection::BUSY` if they cannot — reads go through `db_read` like everything else.
```

and amend **Data & sync** with the three facts that changed underneath it:

```md
- The ingest **commits every 2 000 rows and releases the write connection between batches**,
  so a collection edit during a sync waits one batch, not one sync. `ingest_gz` takes
  `&Mutex<Connection>` for exactly that reason.
- `cards.raw` is a **gzip BLOB** from schema v3 (the column is still *declared* `TEXT` — v1
  is frozen — and SQLite's TEXT affinity leaves a BLOB alone). `json_extract` over it is a
  hard error, not a NULL: read it with `CAST(raw AS BLOB)` and `card_row::raw_json`.
  Nothing reads it at runtime; `artist` has had a column since v3.
- `db::open` sets `PRAGMA auto_vacuum=INCREMENTAL` **before** `journal_mode=WAL` — after WAL
  has materialised the file the pragma is a silent no-op that only a `VACUUM` can apply.
  Databases from Plans 1–2 are converted once, after a sync, by `maintenance` (`compacting`
  phase); a `VACUUM` **always** needs `schema::create_fts` after it.
```

- [ ] **Step 4: Full verify**

```powershell
npm run verify
```
Expected: build, lint (`--max-warnings 0`), Vitest and `cargo test` all green.

- [ ] **Step 5: Live smoke — `npm run tauri dev`**

Run against the real database and record the numbers in this file. Every line is something this plan asserted and has not yet observed:

| # | Check | Expected |
|---|---|---|
| 1 | Add a card from a printings row, an art tile and a table row | three entries, each at the right printing/finish/condition |
| 2 | Add the same printing/finish/condition again | the quantity rises; still one row |
| 3 | Add the same card as foil, as LP, and with a serial number | four rows, the grain doing its job |
| 4 | Collection view: totals against a hand-checked five-card sample | value matches per finish, not per `price_usd` |
| 5 | An etched card in the collection | priced in USD, counted as unpriced in EUR |
| 6 | Filter by set + finish + colour, then Reset all | list and summary agree, both clear together |
| 7 | Sort by set | natural collector-number order, `1★` and `A-123` where the table above says |
| 8 | Wishlist: add "any printing", then acquire one | the row reads "1 of 4 owned"; the search tile shows `×1` and the heart |
| 9 | **Edit the collection during a forced sync** | the add lands within a second; no "busy" toast; search still answers |
| 10 | Force a sync on a Plan-2 database | `compacting` phase appears once; `mtg.db` shrinks; search still finds cards afterwards (FTS rebuilt) |
| 11 | Second forced sync | no `compacting` phase; file size stable (the post-swap `incremental_vacuum` doing its job) |
| 12 | `raw` after a post-v3 sync | `SELECT typeof(raw), sum(length(raw)) FROM cards` → `blob`, and roughly a quarter of the pre-v3 total |
| 13 | Delete a card row by hand, then sync | the entry is flagged with a sentence, still listed, still counted; restoring the row clears it |
| 14 | Pre-warm | after the collection view opens, `data/images/grid` grows for owned cards only |
| 15 | Escape stack | popup → pane → view: one layer per press, focus handed back each time |
| 16 | 1024px width, `prefers-reduced-motion`, keyboard-only pass over both new views | no clipping, no motion, every control reachable with a visible gold outline |
| 17 | Console | 0 CSP violations, 0 errors, 0 React warnings (the tile restructure is the one to watch) |

- [ ] **Step 6: The eight `soon.jpg` printings** — carryover item 8 asked for a verification, not a feature. The improve-path is already automatic (a sync rewrites `image_uris`, and a URI that gains a cache-buster becomes fetchable), so search for one of the eight (`plst UMA-149`, `mic 55`–`58`) and record what it shows and what its `image_status` is now. Note the finding in the carryover file either way.

- [ ] **Step 7: Write the carryover notes** — create `docs/superpowers/notes/plan-3-carryover.md` with: the measured numbers from Step 5, anything deferred out of this plan with its reason, the smoke findings, and the MUST-DO list for Plan 4 (deck tables reference `collection_entries.id` for allocations — the *only* enforced foreign key in the schema, because both sides are user data; `game_changer: true` still has no fixture).

- [ ] **Step 8: Check off every box in this plan and commit**

```powershell
git add -A
git commit -m "chore: complete plan 3 (collection & wishlist)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Carryover ledger

Every MUST-DO from `docs/superpowers/notes/plan-2-carryover.md`, and where it went.

| Carryover item | Landed |
|---|---|
| 1. Write-during-sync policy — chunked ingest recommended | **Task 1.** `ingest_gz` takes `&Mutex<Connection>`, parses outside the lock, commits every 2 000 rows. The bounded-lock fallback is kept as the belt (`db::WRITE_LOCK_WAIT`, `collection::BUSY`). |
| 2a. `artist` column, backfill from `raw`, repoint `ARTIST_SQL` | **Task 2.** The constant is deleted, not repointed — the column is read directly, and `card.rs` no longer touches `raw` at all. |
| 2b. Compress `raw` to gzip BLOB | **Task 2**, as a **write-path** change: the swap replaces every row on the next sync, so the corpus converts for free rather than through a minutes-long one-time rewrite. |
| 2c. One-time `auto_vacuum=INCREMENTAL; VACUUM` **outside `migrate()`**, then `create_fts` (pub, mandatory) | **Task 3.** Home decided and specified: `maintenance.rs`, run at the tail of a successful sync as a `compacting` phase, once per database, failure recorded and not retried. Most databases never reach it — `db::open` now sets the pragma **before** WAL materialises the file (measured; the old order was a silent no-op). |
| 2d. `PRAGMA incremental_vacuum` after `swap_staging` | **Task 3**, inside `do_sync` right after the ingest returns. |
| 3. Single-flight map in `images::Cache` | **Task 13**, as a per-key `Arc<tokio::sync::Mutex<()>>` + re-check-the-disk rather than `Weak<Shared<…>>`: a shared future must be `'static`, which would force `Arc<Cache>` and owned clones of the client and both connections through the protocol handler. Same one-fetch-per-key result, far less surface. |
| 4. `--muted` rename | **Task 9.** `--color-dim` is the app's dim text; `--color-muted` is now the surface shadcn means by it, so the vendoring tripwire is gone. Pinned by `src/lib/tokens.test.ts`. |
| 5. CLAUDE.md image-cache rules (versionless refusal, host allowlist, placeholder `no-store`) | **Task 14.** |
| 6. Host-allowlist observability | **Task 13**, once per process rather than once per tile. |
| 7. `fetch_image` content-length cap | **Task 13** (`MAX_IMAGE_BYTES`, checked before *and* after the read). |
| 8. `image_status` re-fetch-on-improve | **Nothing to build, and verified instead** (Task 14 step 6). The heal is already automatic: a sync rewrites `image_uris`, and a URI that gains a cache-buster becomes fetchable, so the eight `soon.jpg` printings recover with the data. The smoke records what they show today. |
| 9. `SCHEMA_VERSION` const | **Task 2.** |
| 9. `manaValues` dedupe | **Task 6**, inside `filters::push_card_filters`. |
| 9. collector_number natural sort | **Task 6** (`order_by("set")`), verified against `741z`/`1★`/`A-123`/`118†s`/`M21-1`. |
| 9. rarity gem AT-reachable pattern | **Task 9** (`RarityGem`, one component, four call sites). |
| 9. printings rows clickable → add-to-collection | **Task 10.** |
| 9. `store_failures` consumer | **Task 14** (`SyncStatus.imageStoreFailures`, surfaced in the ribbon tooltip). |
| 9. collapse the two bounded-lock helpers | **Task 1** — poison recovery has one definition (`db::lock_blocking`), and `sync::lock_conn`/`lock_db`/`lock_db_read` delegate to it. |
| 9. `PRICES_AS_OF` genuinely shared | **Task 9** (`src/lib/prices.ts`, with `usdPrice`/`eurPrice`). |
| 9. `useDismissOnEscape` doc: does not generalise to two inner peers | **Task 14.** |
| Full collection/wishlist/deck image pre-warm (spec §5, deferred from Plan 2) | **Task 13**, for collection + wishlist, `grid` only. **Deck cards deferred to Plan 4** (no deck tables yet) and **`thumb` to Plan 6** (no view shows one; fetching 9 KB per card for a surface that does not exist is a download, not a pre-warm). |

### Explicitly deferred, with reasons

| Deferred | To | Why |
|---|---|---|
| `decks`, `deck_cards`, `deck_allocations`, `format_specs` (spec §6) | **Plan 4** | The deckbuilder is a plan of its own, and allocations are only meaningful once decks exist. Note for Plan 4: `deck_allocations.collection_entry_id` is the **one** place an enforced foreign key belongs, because both sides are user data and neither is dropped by a sync. |
| Import/export — CSV/Excel/deck-text (spec §7) | **Plan 5** | This plan ships the seam it needs: `conditions.ts`'s synonym table, `condition_original`, and a `collection_add` that upserts on the grain, so the importer's commit is a loop over an existing command rather than a second write path. |
| Settings screen, "Compact database" button, image-cache budget/eviction, "Clear cache" | **Plan 6** | The screen does not exist yet. The compaction it would trigger is not deferred — it has a home now (Task 3), and the button becomes a second caller of `maintenance::convert_to_incremental` that also clears `sync_meta.auto_vacuum_error`. |
| `thumb` pre-warm | **Plan 6** | No view in the app renders a `thumb`. It joins the pre-warm the moment a list view with art does. |
| Keyset pagination for deep offsets (Plan 1 carryover) | **Still deferred** | Plan 2's smoke could not reproduce the 595 ms stall through the grid, and a collection is thousands of rows rather than 116 k, so nothing this plan adds pages deep enough to feel it. |
| Set-picker ranking polish, `Printing`'s four unrendered fields, `role=grid` + roving tabindex, overlay focus containment, Cinzel dead `.woff` | **Plan 6** | Ledgered there by Plan 2's review; none is touched by this plan's files. |
| Non-English printing tracking beyond the `lang` column | **Out of scope (spec §1 non-goals)** | `lang` is stored per entry and part of the grain, so the data model is ready; `all_cards` is 5× the download and is not ingested. |

### Spec coverage

| Spec §6 / §7 requirement | Landed |
|---|---|
| `collection_entries` grain, every field | **Task 4** (DDL) + **Task 5** (writes) |
| `condition_original` preserves the imported string | **Task 4** (column), **Task 9** (`normalizeCondition` produces it) |
| `wishlist_entries`, `card_id NULL` = any printing | **Task 4**, **Task 7**, **Task 10** (the choice in the popup) |
| Virtualized grid/table of owned cards, same filters | **Task 11** (table + `CardGrid` reuse, `filters.rs` shared with search) |
| Sort by name/set/price/date-added/quantity | **Task 6** (`order_by`), **Task 11** (the picker) |
| Inline quantity steppers per finish/condition row | **Task 11** (`QuantityStepper` from **Task 10**) |
| Aggregate header: total, unique, estimated value (USD/EUR, as-of) | **Task 6** (`summarise`), **Task 11** (`CollectionSummaryHeader`) |
| Wishlist mirrors the collection; owned badges in search | **Task 12** |
| Migrations reconciler: merge repoints, delete flags (spec §4.7) | **Task 8** |
| Pre-warm for the user's own cards (spec §5) | **Task 13** |
| Prices always labelled with an as-of date (spec §5) | **Task 9** (`PRICES_AS_OF`), used in **11**, **12** |

---

## Later plans (not in this document)

4. **Deckbuilder & validation** — `decks`, `deck_cards`, `deck_allocations` (the one enforced
   foreign key: `collection_entry_id`, user data on both sides), `format_specs` seeded from
   the research doc's table, zones, drag-and-drop, the full TS validation engine (restricted
   semantics, singleton exceptions, commanders/partners/companions, colour identity),
   Commander bracket estimate — which still needs a `game_changer: true` fixture, and now
   also needs deck cards in the image pre-warm's `UNION`.
5. **Import/export** — CSV/Excel/deck-text importers with preview-then-commit over
   `collection_add`, `conditions.ts`'s synonym table wired to the seven detected formats,
   exporters (Moxfield CSV with verbatim headers, a full-fidelity native CSV, Excel, Arena
   and MTGO text), PDF deck sheets. The collection's sort keys were built CSV-ready for this.
6. **Polish & distribution** — Settings (data folder, sync behaviour, **Compact database**
   calling `maintenance::convert_to_incremental` and clearing `auto_vacuum_error`, **Clear
   image cache**), deck covers using the `art` variant with the artist credit the policy
   requires, licenses screen, `thumb` pre-warm once a list view shows art, set-picker
   ranking, `role=grid` + roving tabindex on both tables, overlay focus containment,
   portable build + ZIP artifact, e2e smoke. The `--chart-*` tokens are still stock greys
   and near-invisible on the dark background; the direction doc's **pie deeps**
   (`--color-pie-*`) are what the collection's value charts should be built from when they
   arrive.
