# Scryfall API compliance, disk-first images, and an error log

**Date:** 2026-08-11
**Status:** approved, ready to plan

## Why

Scryfall's rules are short and they are not advisory. Quoted live from
`https://scryfall.com/docs/api/rate-limits` and
`https://scryfall.com/docs/faqs/i-m-having-trouble-accessing-the-scryfall-api-or-i-m-blocked-17`
on 2026-08-11 (both pages 403 a default HTTP client — they were read with an explicit
`User-Agent`, the same rule the app itself has to follow):

> `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection` — 2/second (500ms).
> `/cards/manifest` — 10/minute (10,000ms). All other methods — 10/second (100ms).
> The direct file origins located at `*.scryfall.io` do not have rate limits.

> Recieving an HTTP 429 response will result in your access being limited for 30 seconds.
> Continuing to overload the API after this point may result in a temporary or permanent
> ban of your application. **It is not acceptable to ignore HTTP 429 responses.**

> We encourage you to cache the data you download from Scryfall or process it locally in
> your own system, at least for 24 hours.

> If you need to rapidly look up card names, prices, or resolve a large number of card
> images, **you must use the bulk data files**.

The app already gets most of this right. This document covers the five places it does not,
plus one bug found while measuring them.

## What is already compliant, and stays unchanged

Recorded here because "make sure we use bulk data" is answered by evidence, not by a change:

* **Card data is bulk-only.** `default_cards` JSONL.gz is the sole source of the 116 k-row
  corpus. There is no per-card API lookup anywhere in the app — `card_detail`,
  `card_printings` and every search read SQLite.
* **Images come from the unlimited file origin.** `cards.scryfall.io`, which the docs
  exempt from rate limits, and `images::is_fetchable` guarantees an image can be fetched
  from nowhere else.
* **Everything fetched is cached locally.** Cards → `cards`, sets → `sets`, migrations →
  `card_migrations`, images → disk + `image_cache`, GitHub releases → `app_meta`.
* **The 24 h floor is honoured.** `sync::CHECK_INTERVAL_SECS` is 86 400 and a second launch
  inside the window makes no network call at all. This matches the documented cadence
  exactly: prices move once a day, so a faster poll would return nothing new.
* **Requests are well formed.** A real app-specific `User-Agent` carrying name, version and
  repository; `Accept: application/json;q=0.9,*/*;q=0.8`; HTTPS only; reqwest negotiates
  TLS 1.2+.
* **`/sets` and `/migrations` stay API calls.** Neither has a bulk equivalent, both are
  polled at most once per 24 h, and `/migrations` is the *only* notice that a card the user
  owns was merged or discarded.
* **`/cards/manifest` is deliberately not adopted.** It would add traffic rather than
  remove it, and the research doc measured `created_at`/`data_updated_at` as null on every
  sampled row, so it cannot answer "what data changed" today.

## 1. An API governor

**Problem.** Nothing paces `api.scryfall.com`. One sync issues 1 bulk check + up to 20
`/sets` pages + up to 20 `/migrations` pages back to back with no delay between them. They
are sequential, so in practice the round trip is the pacing — which means the app is
relying on the network being slow to stay inside a published limit.

**Design.** One choke point. `Client::api_get` becomes an `async` call that every
`api.scryfall.com` request passes through, and it does three things in order:

1. **Refuse if a penalty is in force** (§2), without sending anything.
2. **Wait out the endpoint's minimum interval**, then stamp the next one.
3. **Send.**

The interval comes from a table keyed on the request path, transcribed from the doc:

| Path | Interval |
|---|---|
| `/cards/search`, `/cards/named`, `/cards/random`, `/cards/collection` | 500 ms |
| `/cards/manifest` | 10 000 ms |
| everything else | 100 ms |

The app only uses the last row today. The other two are written down anyway, with a test
pinning the table, so that a future call site cannot silently take the wrong budget.

**Pacing sleeps; a penalty refuses.** A pacing wait is ≤500 ms and invisible. A penalty is
30–300 s and must never occupy a worker thread. This is the same split `images::Cache`
already makes, and the two now share one definition of the clamp.

## 2. A 429 lockout that survives a restart

**Problem.** A 429 is reported and then forgotten. `ScryfallError::RateLimited` carries the
backoff, `sync` writes it to `last_error`, and nothing anywhere remembers it. Pressing
Refresh again sends requests straight back into Scryfall's own 30-second lockout — the
behaviour the docs call unacceptable and escalate to bans.

**Design.** A 429 charges a deadline, clamped to a 30 s floor (the documented lockout) and a
300 s ceiling (a `Retry-After` of a day must not brick the app), honouring `Retry-After`
between them. `max`, never assignment, so a shorter later penalty cannot release a longer
one already in force.

The deadline is stored in `app_meta` as **unix seconds** and restored when the `Client` is
built in `init_state`. Persisting it is the point: restarting the app is otherwise a way to
walk straight back into a live lockout, which is exactly how an application earns a ban.
One write site (`run_sync`'s existing error funnel), one read site (startup). A stored
deadline further away than the ceiling is clamped on read, so a clock that moved cannot
wedge the app.

`images::Cache`'s gate stays in-memory and separate. It guards a different host — one the
docs exempt from rate limits — and merging the two would let a CDN blip mute the API.

## 3. Bounded retry for transient failures

**Problem.** There are no retries. One 503 on `/sets` fails the whole run.

**Design.** Up to 3 attempts, exponential backoff with jitter, for **5xx, timeouts and
connect errors only**. Never for 429 — that is a lockout, not a retry, and retrying it is
the specific thing the docs forbid. Never for 404. The backoff is bounded well under the
read timeout so a retrying call cannot outlive the sync that spawned it.

## 4. Images: store on disk, load from disk, refetch only when the art changed

**Problem.** The bytes are stored, but the *row that vouches for them* is written with a
zero-wait `try_lock`:

```rust
if let Some(conn) = crate::db::lock_for(write, Duration::ZERO) {
    let _ = record(&conn, key, uri, bytes.len());
}
```

`Cache::get` decides a hit with `is_current`, which reads that row. So when the write
connection is contended — during an ingest it is held for all but the gaps between
2 000-row batches — the file lands on disk and **no row is ever written**. The module's own
doc calls this "one extra request", but the row is never retried: the file sits on disk
unread and *every future request for that key refetches, forever*.

**Design.** The disk is the cache and the row is bookkeeping that may not be lost.

* `record` takes a **bounded wait** instead of `Duration::ZERO`.
* If it still cannot be written, the record is held in a small bounded pending map and
  flushed on the next successful lock. Overflow is counted and logged (§6) rather than
  silently dropped.
* Freshness stays exactly as it is: `is_current` compares the stored `source_uri`
  character for character, cache-buster and all. Scryfall's `?<epoch>` **equals**
  `image_updated_at`, so "has the art been updated more recently than ours" is already a
  string comparison with no clock in it. A re-scanned card refetches; nothing else does.
  This is pinned by a test rather than left as a property nobody checks.

## 5. The deck builder fetched every image cold

**Problem — measured, not inferred.** Against the live database on 2026-08-11:

```
image_cache by variant : grid 4805 · display 164 · art 14
distinct deck cards    : 17
  ...with a `grid` row : 17   (100%)
  ...with an `art` row : 12   ( 71%)
collection + wishlist  : 0
```

Every deck surface renders the **`art`** variant — `CardStack.tsx:210`,
`views/GridView.tsx:143`, `DecksPage.tsx:761,875`, `TheoryDiffDialog.tsx:483`,
`DeckSettingsDialog.tsx:444,514`. But both warming paths produce **`grid`**:

* `SearchPage.tsx:206` → `prefetchImages(ids, "grid")`, the only `prefetchImages` call in
  the app.
* `images.rs:1187` → `prewarm_keys(&conn, Variant::Grid, MAX_PREWARM)`, hardcoded — even
  though the query's third arm selects `deck_cards` and its comment says that arm exists
  "because the deck gallery and the deckbuilder show art like every other surface".

`art` is a different CDN URL, so a 100 %-warm `grid` cache contributes nothing to the deck
builder. With no collection and no wishlist, the deck arm is the only work prewarming has
ever had to do, and it warmed a variant no deck surface requests. Search answers from 4 805
warm files at 2–3 ms; the deck builder fetches cold for effectively every tile, from plain
non-virtualised scrollers that mount every row at once, against 16 permits — and each miss
can burn the full 10 s `IMAGE_TIMEOUT` before the `<img>` sees its 502. That is the
reported "images load in search but not the deck builder, with timeouts".

**Design.** Warm the variant each surface actually draws:

* `prewarm_collection` runs the collection and wishlist arms at `grid` and the `deck_cards`
  arm at `art`, so the arm finally warms what the deck builder reads.
* The deck editor and the deck gallery call `prefetchImages(ids, "art")`, the way
  `SearchPage` does for its wall.
* A test pins the pairing, so a surface that changes variant cannot silently un-warm
  itself again.

## 6. An error log in Settings

**Problem.** Failures are close to invisible. `sync_meta.last_error` is one string the next
run overwrites, and the rest are `eprintln!` — reconcile, orphan sweep, page reclaim,
compaction, image store — which in a release build have no console to print to. The user
cannot see that anything failed, and neither can anyone debugging it.

**Design.** Schema **v9** adds `error_log`:

| column | meaning |
|---|---|
| `id` | primary key |
| `first_at` / `last_at` | unix seconds, first and most recent occurrence |
| `source` | `scryfall_api` · `scryfall_image` · `github_update` · `database` · `image_store` |
| `operation` | `bulk_check`, `download`, `sets`, `migrations`, `image_fetch`, … |
| `kind` | `rate_limited` · `timeout` · `http` · `io` · `parse` · `other` |
| `message` | what happened, one sentence |
| `detail` | the URL or card id, nullable, most recent wins |
| `count` | occurrences folded into this row |

**Coalescing is the whole design.** A unique index on
`(source, operation, kind, message)` means 600 failed image fetches are one row reading
`×600`, not 600 rows — the path-MTU incident recorded in `CLAUDE.md` produced exactly that
shape. `detail` is deliberately outside the key so a per-URL string cannot defeat the
folding; it keeps the most recent value. Retention is a newest-N cap applied on insert.

**Recording can never fail the thing it describes.** `errors::record` is best-effort with a
bounded lock wait, returns `()`, and is called from paths that already tolerate failure.
It is called *inside* the caller's transaction where one is open, so a rolled-back write
leaves no history — the rule `deck_audit` already follows.

**IPC and UI.** `error_log_list(limit)` and `error_log_clear()`. `SettingsPage` gains an
`ErrorLogPanel`: newest first, relative time, source, message, `×N` when folded, and a
Clear button; and an empty state saying nothing has failed. Storybook story and
`.storybook/fake` wiring, per the repo's rules for a new panel.

**Dropped during implementation: the live lockout countdown.** This section originally
called for a notice showing the time remaining on an active 429. `SettingsPage` receives
only `update` from `App.tsx`, and the sync status lives in `AppShell`'s `useSync` — so
surfacing a countdown meant either a second `useSync` (a second poller, the arrangement
`useUpdate` is deliberately structured to avoid) or threading a new prop through two
components for one line of text. The log's own `rate_limited` rows carry the message and
when it last happened, which answers the same question without either. Worth revisiting if
the ribbon ever wants it, where the poll already exists.

## Testing

* **Rust.** The interval table against the documented figures; a paced burst measured;
  a 429 refusing the next call without sending it; the penalty surviving a save/restore
  round trip and being clamped; retry counts per error class, and 429/404 *not* retried;
  the image record surviving a contended write connection; `is_current` refetching on a
  changed cache-buster and only then; the prewarm variant pairing; `error_log` coalescing,
  its cap, and a rolled-back transaction leaving no row.
* **TypeScript.** `ipc.ts` mirrors for the two new commands; `ErrorLogPanel` rendering,
  folding and empty state; the deck prefetch call sites.
* **Live.** A CDP pass over the shipped window: open a deck twice and confirm the second
  visit serves from disk; confirm the Settings panel lists a real failure.

## Out of scope

Adopting `/cards/manifest`; a rulings feature; any change to the image cache's on-disk
layout (a version-stamped filename would make a disk hit self-validating, but it would
invalidate ~5 000 cached files and cost a ~300 MB refetch — the opposite of the point).
