# Plan — Scryfall API compliance, disk-first images, error log

Spec: `docs/superpowers/specs/2026-08-11-scryfall-api-compliance-design.md`

Execute in order. Each task ends green (`cargo test` for Rust tasks, `npm run verify`
before the PR) and gets its own commit.

---

## Task 1 — The endpoint-interval table and the API governor
**Files:** `src-tauri/src/scryfall.rs`

- [ ] `MinInterval`: a `fn min_interval(path: &str) -> Duration` transcribing the doc —
      500 ms for `/cards/search|named|random|collection`, 10 s for `/cards/manifest`,
      100 ms otherwise. Match on the **path**, not the full URL, so a `next_page` URL from
      Scryfall is classified the same as one we built.
- [ ] `Governor` on `Client`: `tokio::sync::Mutex<Instant>` next-allowed. `api_get` becomes
      `async fn api_send(&self, url) -> Result<Response, ScryfallError>` — the only way this
      module issues an API request. `fetch_sets`/`fetch_migrations`/`check_bulk_update`
      route through it.
- [ ] Move `rate_limit_penalty` from `images.rs` into `scryfall.rs` (floor
      `RATE_LIMIT_BACKOFF_SECS`, ceiling 300 s); `images.rs` calls it. One definition.

**Tests:** the table against the documented figures; a burst of N requests to one mock path
takes at least (N-1) × interval; a `next_page` URL is classified by path.

## Task 2 — The 429 penalty, persisted
**Files:** `src-tauri/src/scryfall.rs`, `src-tauri/src/sync.rs`, `src-tauri/src/lib.rs`

- [ ] `Client` holds `penalty_until_unix: Mutex<u64>`. `charge_penalty(secs, now)` takes the
      `max`; `penalty_remaining(now)` answers the wait.
- [ ] Every 429 arm charges it before returning `RateLimited`.
- [ ] `api_send` refuses inside a live penalty **without sending**, returning the remaining
      time.
- [ ] `app_meta` key `scryfall_penalty_until`. `init_state` restores it (clamped to the
      ceiling on read); `run_sync`'s existing error funnel persists it.

**Tests:** a 429 shuts the gate and the next call sends nothing (mock hit count stays 1);
save/restore round trip; a stored far-future deadline is clamped; a shorter penalty does
not release a longer one.

## Task 3 — Bounded retry
**Files:** `src-tauri/src/scryfall.rs`

- [ ] `retryable(&ScryfallError) -> bool`: 5xx, `Timeout`, and transport errors. **Not**
      `RateLimited`, `NotFound`, `SizeMismatch`, or a parse failure.
- [ ] Up to 3 attempts, exponential backoff with jitter, inside `api_send`. Not applied to
      `download` (it has its own resume path) or `fetch_image` (its own deadline, and the
      grid's `useImageRetry` above it).

**Tests:** a mock 503-then-200 succeeds in one call; a 429 is attempted exactly once; a 404
is attempted exactly once; three 503s give up and report.

## Task 4 — The image record must not be lost
**Files:** `src-tauri/src/images.rs`

- [ ] `record` under a **bounded** wait, not `Duration::ZERO`.
- [ ] A bounded pending map for records that still could not be written, flushed on the next
      successful lock. Overflow counted and logged.
- [ ] Rewrite `fetch_and_store`'s doc comment: the degradation it documents is the bug this
      closes, and the comment must not keep asserting the old justification.

**Tests:** a record written while the write connection is held lands once the lock frees;
`is_current` is false for a changed cache-buster and true for the same URI; a second `get`
after a contended store performs no second fetch.

## Task 5 — Warm the variant each surface draws
**Files:** `src-tauri/src/images.rs`, `src/features/decks/DeckEditor.tsx`,
`src/features/decks/DecksPage.tsx`

- [ ] `prewarm_collection`: collection + wishlist arms at `grid`, `deck_cards` arm at `art`.
      `prewarm_keys` takes the arm it is selecting for rather than one variant for all three.
- [ ] `DeckEditor` and `DecksPage` call `ipc.prefetchImages(ids, "art")` for the cards and
      covers on screen, mirroring `SearchPage.tsx:206` (fire-and-forget, `.catch(() => {})`).

**Tests:** Rust — the deck arm yields `art` keys and the other two `grid`. TS — the deck
editor prefetches the ids it renders, with variant `art`.

## Task 6 — `error_log`, schema v9
**Files:** `src-tauri/src/schema.rs`, new `src-tauri/src/errors.rs`

- [ ] `SCHEMA_VERSION` 8 → 9; an `if v < 9` step creating `error_log` and its unique index
      on `(source, operation, kind, message)`.
- [ ] `errors::record(conn, Source, operation, kind, message, detail)` — upsert bumping
      `count` and `last_at`, `detail` overwritten with the most recent; newest-N cap applied
      on insert. Best-effort, returns `()`.
- [ ] `errors::list(conn, limit)` with `clamp(1, 500)` — a negative `LIMIT` is *no* limit in
      SQLite.

**Tests:** two identical failures fold to one row with `count = 2` and a moved `last_at`; a
differing `detail` still folds; the cap evicts oldest by `last_at`; a rolled-back
transaction leaves no row; the limit clamp.

## Task 7 — Wire the recording sites
**Files:** `sync.rs`, `images.rs`, `update.rs`, `reconcile.rs`, `maintenance.rs`

- [ ] Scryfall API failures (`run_sync`'s funnel, distinguishing rate limit / timeout / http).
- [ ] Image fetch failures and image *store* failures.
- [ ] GitHub update check and download failures.
- [ ] The five `eprintln!`-only sites: reconcile apply, orphan sweep, page reclaim,
      compaction, migration fetch. Keep the `eprintln!` — a dev console is still useful —
      and add the row beside it.

## Task 8 — Commands and the Settings panel
**Files:** `src-tauri/src/lib.rs`, `src/lib/ipc.ts`, `src/lib/useErrorLog.ts`,
`src/features/settings/ErrorLogPanel.tsx`, `SettingsPage.tsx`, stories, `.storybook/fake`

- [ ] `error_log_list` / `error_log_clear` registered in `invoke_handler`.
- [ ] `ipc.ts` mirror + `ipc.test.ts` argument-shape tests (the `prewarm_collection` trap:
      a command taking no arguments must be invoked with none).
- [ ] `useErrorLog` — react-query, invalidated on a `sync:progress` `error` phase.
- [ ] `ErrorLogPanel`: newest first, relative time, source, message, `×N`, Clear, empty
      state, and the active-lockout notice with time remaining.
- [ ] Story with `autodocs`; `.storybook/fake` gains the two commands and an `errorLog` seed
      + fault.

## Task 9 — Docs, verify, PR
- [ ] `CLAUDE.md`: the compliance rules and the measured findings (the variant mismatch, the
      lost-record bug, the interval table, the persisted penalty, schema v9).
- [ ] `npm run verify` and `cargo test` both green, output quoted.
- [ ] Live CDP pass: a deck opened twice serves from disk the second time; the Settings
      panel lists a real failure.
- [ ] Push and open the PR.
