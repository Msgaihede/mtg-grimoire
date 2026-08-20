# Image cache

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Files live at `<data dir>/images/<variant>/<id[0..2]>/<id>-<face>.webp`; `image_cache`
  rows and files stay 1:1, and the row's `source_uri` — Scryfall's `?<epoch>` cache-buster
  — is the only invalidation signal. Deleting `data/images` is always safe.
- **Settings can delete it, and `reset::cache_clear` is the one command that does** (added
  2026-08-20). It drops every `image_cache` row, sweeps `data/images/` and `data/tmp/` file by
  file, and then drains `Cache::pending` — in that order, and the order is the part worth
  keeping. A row that outlives its file is already a supported state (`Cache::get` reads
  `cached` from the row, fails the file read, and treats it as a miss), so the window between
  the first two steps only costs a re-fetch. `pending` goes **last** because it holds rows
  *owed* for bytes already on disk: drain it first and a fetch landing mid-walk re-queues, and
  the next served image writes a row for a file that is gone — a permanent re-fetch of that key,
  the exact leak `flush_records` exists to close.
  It **refuses outright while a sync is running**: `data/tmp/` is where the corpus download puts
  77 MB the ingest then reads back, and a sweep landing between the write and the read fails a
  90-second job the reader is watching a progress bar for. It never touches `data/covers/` —
  those are pictures the reader *chose* — and no table but `image_cache`.
  Measured on this machine 2026-08-20: **5,540 files, 329,682,302 bytes** in `data/images/`.
- A `grid` image averages **59.6 KB**. 600 browsed cards cost ~36 MB, so all 116 k
  printings at `grid` would be ~7 GB — which is why Plan 3's pre-warm is scoped to what
  the user owns rather than to the database.
- **Those are `grid`'s figures, and every card surface moved to `display` on 2026-08-20.**
  `display` is 672×936 against `grid`'s 488×680 and averages **~93 KB** (Scryfall's own
  published figure; the 59.6 KB above was measured here and the equivalent re-measurement has
  not been taken), so the same 600 browsed cards are ~56 MB and the 116 k extrapolation is
  ~11 GB. The scoping argument is unchanged and the ratio is the thing to carry forward, not
  the absolute.

  **The reason is that the walls zoom and the variant did not.** A tile is 170px at 1× and
  340px at the top of `cardZoom`'s ladder; on a monitor at 200% scaling that is 680 device
  pixels drawn from a 488px source, a 39% upscale, and it is the blur readers reported.
  `display`'s 672 covers that worst case. The variant is still chosen per surface rather than
  per rendered size — nothing reads `devicePixelRatio` — so the rule to keep is that **a
  variant argued from a tile's base width is the wrong measurement**: both constants that moved
  had been justified at 100% zoom on an unscaled display.

  **The +50% per card is the wall-only case and the worst one.** `CardDetailPane` and
  `PrintingPreview` were already on `display`, so a card the reader opens used to cost two
  cache keys (~62 KB + ~93 KB) and now costs one. Cards already cached at `grid` are **not
  migrated or deleted** — a variant is its own directory, so the old files simply stop being
  read and stay until the user deletes `data/images`, which is always safe. Every such card
  re-fetches once at the new URL; nothing paces that and `cards.scryfall.io` has no rate limit.

  Scryfall's `png` (745×1040) is larger still and was rejected: ~11% more linear resolution for
  roughly ten times the bytes, and it is not in the database at all — the ingest keeps four of
  the eleven image keys and drops the JPG/PNG family Scryfall's own docs mark as *replaced*
  (`card_row::webp_uris`), so it would need a schema migration and a backfill.
- Warm serve **2–3 ms**, cold single image **~127 ms**. A cold screenful of 20 tiles is
  **80–270 ms** after the query lands — re-measured 2026-08-09, against **2 348–2 676 ms**
  for the same five searches on the commit before (same machine, same corpus, `data/images`
  cleared before each run, five identical cold terms plus five never-fetched ones).
- **Nothing paces an image fetch, and that is deliberate.** The old 100 ms interval was
  `api.scryfall.com`'s ≤10/s rule charged to `cards.scryfall.io`, which the research doc
  records as having **no rate limit** — and `is_fetchable` guarantees an image can come from
  nowhere else. It capped the whole app at 10 images/s, which was most of the 2.4 s above.
  `MAX_CONCURRENT_FETCHES` (**16**) is now the whole of the pacing and it bounds _this_
  machine — sockets, worker threads, bodies in flight — not Scryfall's patience. The 429
  machinery is untouched: `Cache.gate` still carries a penalty deadline, still answers a
  request inside one at once with the time remaining, and `penalise` still takes the `max`.
  Measured over ~600 live images across two sessions: **zero** 429s, zero 502/503.
- A page of search results warms itself: `images::prefetch_images` takes front faces only,
  caps the batch at 100, and is fire-and-forget — it resolves when the work is _queued_.
  It walks the page **in reading order**. It used to walk backwards so it would not collide
  with the tiles the grid had just mounted, on the premise that "nothing dedups a fetch that
  is already in flight" — which Plan 3's single-flight map made false. Colliding at the head
  is now the _good_ case (a wait on a request already going out); walking backwards spent
  the permits on cards fifty rows below the fold.
- A printing with no art anywhere (162 of them) is a **200 with an SVG placeholder** at the
  variant's exact dimensions, never a 404 and never a cache row. Only a real failure is an
  error: 502 for a failed fetch, 503 + `Retry-After` for a rate limit.
- `mtgimg:` is an `img-src` and nothing else — a `fetch()` at it fails CORS by design (no
  `Access-Control-Allow-Origin`, because an `<img>` load is no-cors). Read images with
  `<img>`, never with `fetch`.
- A card image URI with no `?<epoch>` cache-buster is **refused at resolution** — it is
  uncacheable by construction, so it resolves to the no-image placeholder and never to
  bytes. This heals itself: the printings that publish `errors.scryfall.com/soon.jpg` in all
  four slots were **eight** on 2026-08-04 and are **four** (`mic 55`–`58`) on 2026-08-05,
  because a sync rewrites `image_uris` and a URI that gains a cache-buster becomes
  fetchable. No code is involved; do not build a re-fetch path for it.
  `cards.scryfall.io` is the **only** host images are fetched from; an off-host URI is
  refused and warned about once per process. A placeholder is served `no-store` (it is the
  one 200 whose content is meant to change), real bytes `max-age=86400`.
- Images are fetched **once per key** even when a screenful asks at the same moment
  (`Cache`'s per-key mutex + a re-read of the disk). The waiter re-reads rather than being
  handed the bytes, so it degrades to a second fetch when the write connection was busy or
  the store failed — both acceptable, both documented at `images::fetch_and_store`.
- **`mtgimg://` has a second route, and it touches Scryfall not at all: `/cover/<deckId>`.**
  `images::serve` tries `parse_cover_path` **first**; it cannot collide with the card route
  because `Variant::parse("cover")` is `None`. The bytes are a file the user picked, re-encoded
  by `images::encode_cover` (magic-number sniff, `resize_to_fill` to the `art` crop's **626×457**,
  lossless WEBP, source capped at `MAX_COVER_SOURCE_PIXELS`) and written to
  `<data dir>/covers/<deckId>.webp`. **The route resolves that directory itself** — `decks
.cover_image_path` is a record of what was written, not what is read, which is what keeps a
  portable install working after its folder moves. Served `no-store`, because it is the one image
  URL whose content is _meant_ to change under a fixed name; **404 when absent, never a
  placeholder**. The `i64` parse is the whole path-traversal fence, since the id becomes a
  filename (`a_cover_path_is_parsed_or_refused_and_never_repaired` pins `/cover/../../mtg.db`,
  `/cover/..%2fmtg.db`, `/cover/7/8`, `/cover/7.webp`).
- **The CSP did not change for it, and that is the point.** `img-src 'self' data: mtgimg:
http://mtgimg.localhost` already covered a fifth _path_; a route is not a source.
  `images::tests::the_shipped_csp_is_untouched` asserts both the exact `img-src` and that the
  policy does not mention `cover` at all. Measured 2026-08-11 in the shipped window: with no file
  on disk the URL errors, and after one `deck_set_cover_image` the same URL loads **626×457 in
  2 ms**.

## The protocol and the CSP

- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where
  the origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere.
  Variants are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never
  fetched. The handler reads through `db_read`, never the write connection. `app.security.csp`
  is not `null` any more — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
