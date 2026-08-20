# Talking to Scryfall

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

The two pages that bind this app are `/docs/api/rate-limits` and the "I'm blocked" FAQ. Both
**403 a default HTTP client**, which is itself the first rule: read them with an explicit
`User-Agent`. What they require, and what already satisfies it:

- **`api.scryfall.com` is paced, and there is exactly one place it can be.**
  `scryfall::Client::api_send` is the only way this module issues an API request: it refuses
  inside a lockout, waits out the endpoint's interval, adds `Accept`, and retries. The
  interval table is transcribed from the doc — **500 ms** for `/cards/search|named|random|
collection`, **10 s** for `/cards/manifest`, **100 ms** for everything else — and is keyed on
  the **path**, because Scryfall hands back absolute `next_page` URLs and a page 2 must take
  the same budget as the page 1 we built. Only the last arm is used today; the other two are
  written down and tested so a future call site cannot quietly take five times its budget.
- **Pacing sleeps, a 429 refuses.** A sub-second wait is invisible and worth taking; parking a
  worker thread for up to five minutes is not, and a second caller could not report its own
  rate limit until the first sleeper woke. Same split `images::Cache::fetch` already made.
- **A 429 is remembered across a restart.** `rate_limit_penalty` clamps to 30–300 s (one
  definition, shared with the image cache's gate), `max` never assignment, persisted to
  `app_meta.scryfall_penalty_until` and restored in `init_state`. Scryfall limits the
  _application_, not the process — "It is not acceptable to ignore HTTP 429 responses", and
  repeat offenders are banned — so restarting must not be a way back in.
- **Retry is for what is nobody's answer**: 5xx, timeouts, connect failures, 3 attempts,
  exponential backoff with jitter. **Never a 429** (the docs forbid exactly that) and never a 404.
- **Bulk data is already the only card source, and that is the compliance story.**
  `default_cards` JSONL.gz feeds the 116 k corpus; there is no per-card API lookup anywhere.
  **Two more bulk datasets joined it**, both from Scryfall Tagger:

  | | `oracle_tags` | `art_tags` |
  | --- | --- | --- |
  | manifest id | `bd8df61e-5d0a-47a2-9086-40137a645b98` | `48da5752-eeb6-4126-bf97-8829e20ad14f` |
  | `compressed_size` | **5 846 422 bytes** | **12 544 874 bytes** |
  | tags | 4 521 | 11 531 |
  | taggings | 229 633, keyed on `oracle_id` | 475 163, keyed on `illustration_id` |
  | closure rows | — | 951 499 (2.0× the taggings) |
  | measured | live 2026-08-14 | live 2026-08-20 |

  Both manifest entries have the same shape as `default_cards`' — **`jsonl_download_uri` and
  `compressed_size` only**, neither of the pre-2026-07-20 `download_uri`/`size` fields, and no
  legacy fallback on either the index endpoint or the per-type one — which is why one `BulkInfo`
  describes all three and `Client::check_bulk_dataset` is the one call that fetches any of them.
  Each goes through `api_send` like everything else, so they spend the same pacing budget and
  honour the same 429 lockout.
  **Both are checked weekly while Scryfall regenerates them daily**, and the two cadences must not
  be blurred: Scryfall's `docs/api/tags` says the files are updated daily and both `updated_at`
  stamps were the previous day when checked on 2026-08-20, while the week is
  `tags::{oracle,art}::REFRESH_INTERVAL_SECS` — this app's own answer to how often to ask, because
  the taxonomies are hand-curated and a card's categories should not regroup between two sessions
  on the same afternoon. Full figures:
  [the oracle research](../superpowers/research/2026-08-14-scryfall-oracle-tags.md) and
  [the art one](../superpowers/research/2026-08-20-scryfall-art-tags.md).
- **`scryfall.com/docs/*` and `tagger.scryfall.com` 403 a non-browser User-Agent;
  `api.scryfall.com` and `data.scryfall.io` do not.** The block is on the UA rather than on
  authentication — `curl.exe` sending an ordinary Chrome UA gets HTTP 200 from both HTML sites,
  and the API wants `MTGGrimoire/0.1 (+…)` and answers normally. **This is not a tooling bug to
  re-investigate**: WebFetch cannot reach either HTML site, and neither can headless Edge behind
  the Cloudflare challenge. Verified 2026-08-14 for the docs site and 2026-08-20 for Tagger. It is
  also the reason nothing in this app scrapes Tagger: everything it needs is in the two bulk
  files, which come off `data.scryfall.io` and are not rate-limited at all.
- `/sets` and `/migrations` stay API calls because neither has a bulk equivalent, and both are
  polled at most once per 24 h. **`/cards/manifest` is deliberately not adopted**: it would add
  traffic rather than remove it, and the research doc measured `created_at`/`data_updated_at`
  as null on every sampled row, so it cannot answer "what data changed" today.
- **The error log is `error_log`, schema v9, and repeats fold.** The grain is
  `(source, operation, kind, message)`; `detail` sits **outside** it because it carries the
  per-occurrence URL that would defeat the folding, and the newest one wins. That is what turns
  the path-MTU incident's ~600 failed fetches into one row reading `×600`. Capped at 200 rows,
  evicting least-recently-seen. `errors::record` returns `()` — it can never fail the thing it
  describes — and is called inside the caller's transaction, so a rolled-back write leaves no
  history, exactly as `deck_audit` does. It carries the five failures that previously reached
  only `eprintln!` (reconcile, orphan sweep, page reclaim, compaction, image store), which in a
  release build has no console to print to.
- **An image's bookkeeping row is owed, not optional.** It used to be written under a
  zero-wait `try_lock` and _dropped_ when the write connection was busy — which during an
  ingest it is, for all but the gaps between its 2 000-row batches. Nothing retried it, so the
  bytes sat on disk that `is_current` would never vouch for and **every later request refetched
  them for the life of the installation**. The row is now queued in `Cache::pending` and paid
  off by whichever later call finds the connection free, with a flush at exit beside the WAL
  checkpoint. The module's old doc comment called this "one extra request"; it was not.
- **Freshness is the URI, and that is the whole rule.** `is_current` compares the stored
  `source_uri` character for character, and Scryfall's `?<epoch>` cache-buster **equals**
  `image_updated_at` — so "has the art been updated more recently than ours" needs no clock and
  no mtime. A re-scanned card refetches; nothing else does.
- **`prewarm_keys` pairs each arm with the variant its screen draws, and the pairing is the
  contract — the variants agreeing today is not.** `COLLECTION_PREWARM`/`DECK_PREWARM`, mirrored
  in TS as `cardControl.tsx`'s `DECK_CARD_VARIANT`, which `DeckEditor` passes to
  `prefetchImages`. Getting it wrong is **invisible**: the pre-warm reports having warmed every
  card and the screen then fetches every tile cold anyway, each variant being a different URL on
  the CDN. Measured against the live database 2026-08-11, when the deck arm was warming `grid`
  and every deck surface drew `art`: all 17 deck cards had a `grid` row, **12** had an `art` one,
  and with an empty collection and wishlist the `deck_cards` arm was the _only_ work there was —
  a 100 %-warm cache that bought nothing, from plain scrollers that mount every row at once
  against 16 permits, which on a slow link reads as timeouts.
  **Both arms are `Grid` since the deck's stack and grid views draw the whole card**, so a card
  that is both owned and in a deck is **one** key again rather than two — the `UNION` (never
  `UNION ALL`) collapses it with no code noticing. They stay two constants because a future
  surface could move one without the other. `DecksPage` still warms `"art"` and is not this: it
  warms **covers**, which are 626×457 by construction.
