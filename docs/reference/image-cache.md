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
  90-second job the reader is watching a progress bar for. It touches no table but `image_cache`.
  **Those two directories are now the whole of its reach, and the list is exhaustive rather than
  illustrative.** Until 2026-08-31 this sentence read "it never touches `data/covers/` — those
  are pictures the reader *chose*", which was the one promise the button was documented as
  making about a *third* directory. Custom deck covers went that day, so there is no third
  directory to spare and no promise left to keep; `reset.rs`'s module doc carries the same
  correction. The folder itself is not deleted on upgrade — see the standing note in the
  `/cover/` bullet below.
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
- **A request the protocol never answers is the one failure the app could not see, and it is why
  a wall sometimes finished with two black cards in it.** Reported 2026-09-01: "some card images
  don't load and appear stuck, but as soon as I mouse over them they continue loading."
  Investigated against the reporter's own dev database, which is what settles where it is *not*.
  The stuck tile in the screenshot was **Accomplished Alchemist** (`pstx` 119p): its `display`
  bytes had been on disk since **2026-08-22**, 81 816 of them, and `image_cache.source_uri`
  still equalled `cards.image_uris.display` — so `is_current` vouched for the row and `Cache::get`
  answered it from `tokio::fs::read` in the 2–3 ms a warm serve costs. No fetch, no permit, no
  gate. **`error_log` held zero rows from `scryfall_image` or `image_store`, ever** — the two
  rows in it were the relay's — so no 502, no 503, no 429 and no timeout ever reached the
  renderer either. The fetcher is exonerated end to end.

  What is left is the delivery. **On Windows every `mtgimg:` response is handed to the UI thread
  with `PostMessageW`** — `wry 0.55.1`'s `webview2::dispatch_handler`, because the responder is
  called from a tokio task and `ICoreWebView2WebResourceRequestedEventArgs::SetResponse` and the
  deferral's `Complete()` may only be touched there. The post's failure is *ignored*
  (`let _res = PostMessageW(…)`, warned about in a debug build and nowhere else), and a post that
  does not arrive leaves the boxed closure leaked and the deferral uncompleted **forever**. An
  `<img>` in that state fires no `load`, no `error` and nothing in the console, and
  `useImageRetry` — which only ever reacted to `error` — had no way to know: the frame drew the
  empty box with no fallback text, which is exactly the screenshot.

  So `CardImage` watches for silence: a frame with a layout box that has heard nothing by
  `IMAGE_STALL_DEADLINE_MS` re-requests with a `?stall=N` mark, twice, then dispatches `error` on
  the element so the ordinary backoff takes over. The mark is a query string and `images::serve`
  parses only the path, so nothing between the renderer and the handler can answer the second ask
  out of what it made of the first.

  **The deadline is 5 s against a measured ceiling of 451 ms.** Timed in the shipped window
  (debug build, 1691×911 client, the reporter's own corpus and image cache) over **400** tiles of
  the search wall on 2026-09-01: **p50 7 ms, p90 275 ms, p99 421 ms, max 451 ms**. A deliberate
  burst of **200 simultaneous** warm protocol requests returned a median of **116 ms** and a worst
  of **167 ms**; repeated with the machine held at **72 % CPU** across 16 cores, 132/216 ms. It
  costs little when it fires early, because `Cache::get` is single-flight per key: a second ask
  for a picture already being fetched waits on that key's mutex and reads what the first one
  writes, so pre-empting a slow *network* fetch — itself bounded at 10 s by `IMAGE_TIMEOUT` —
  buys one extra local request and no extra download.

  **What could not be reproduced, and it is worth writing down so nobody re-runs it.** Across
  roughly 3 300 images driven over CDP in one session: jump scrolling, real `mouseWheel` bursts
  with quiet settles, 400-tick runs into uncached cards (330 genuine cold fetches), a data
  refresh pressed mid-browse, the window fully occluded by a topmost window, and the 200-way
  burst above under 16-way CPU load — **zero failed, zero stalled**, and a screenshot-and-canvas
  pass measuring the pixel variance of every fully visible tile found no loaded-but-unpainted
  frame either. The trigger is rarer than a test harness can provoke on demand, which is the
  argument for healing the state rather than for hunting it further. Hovering was also checked
  and does **not** remount a tile's `<img>` — the same element survives the pointer — so
  "it loads when I mouse over it" is the app being woken, not the tile being redrawn.
- Images are fetched **once per key** even when a screenful asks at the same moment
  (`Cache`'s per-key mutex + a re-read of the disk). The waiter re-reads rather than being
  handed the bytes, so it degrades to a second fetch when the write connection was busy or
  the store failed — both acceptable, both documented at `images::fetch_and_store`.
- **`mtgimg://` had a second route and now has one. `/cover/<deckId>` went on 2026-08-31, with
  the custom deck cover it existed to serve.** A cover is `decks.cover_card_id` — the art crop of
  a card — which the *card* route already serves as an ordinary image, so nothing replaced this
  one: `images::serve` parses `/<variant>/<card id>/<face>` and that is the whole protocol.
  Deleted with it: `parse_cover_path`, `COVER_ROUTE`, `encode_cover`, `encode_cover_picked`,
  `encode_cover_from`, `write_cover`, `cover_file`, `serve_cover`, `MAX_COVER_SOURCE_PIXELS`,
  `paths::covers_dir` and the `deck_set_cover_image` command. **`COVER_VARIANT` went too**, and
  it is the one deletion that was in doubt: the plan flagged it as possibly load-bearing on the
  card-art path and asked for it to be checked rather than assumed. It was
  `pub const COVER_VARIANT: Variant = Variant::Art`, and its whole job was to promise that a
  re-encoded upload came out the same 626×457 as a crop — a promise with only one kind of
  picture left to make. Every surface that drew a cover now names `Variant::Art` directly,
  which is what `images.rs`'s own header says about the four deck surfaces that ask for `art`
  rather than `display`. Anything still citing `images::COVER_VARIANT` — the module-boundary
  audit and the 2026-08-12 deckbuilder spec both do — is describing the shape as it was.

  **What it was, kept because the shape is the argument for how it was built.** The bytes were a
  file the user picked, re-encoded by `images::encode_cover` (magic-number sniff, `resize_to_fill`
  to the `art` crop's **626×457** so a tile could wear either kind without the layout shifting,
  lossless WEBP, source capped at `MAX_COVER_SOURCE_PIXELS`) and written to
  `<data dir>/covers/<deckId>.webp`. `images::serve` tried `parse_cover_path` **first** and it
  could not collide with the card route, because `Variant::parse("cover")` is `None`. The route
  resolved the directory itself — `decks.cover_image_path` was a record of what had been written,
  never what was read, which is what kept a portable install working after its folder moved. It
  was served `no-store`, being the one image URL whose content was _meant_ to change under a fixed
  name, and answered **404 when absent, never a placeholder**. The `i64` parse was the whole
  path-traversal fence, since the id became a filename;
  `a_cover_path_is_parsed_or_refused_and_never_repaired` pinned `/cover/../../mtg.db`,
  `/cover/..%2fmtg.db`, `/cover/7/8` and `/cover/7.webp`, and went with the parser.

  **`<data dir>/covers/` is not swept on upgrade and nothing reads it.** The v32 rung flips
  `cover_kind` and writes nothing else, so an install that had custom covers keeps its
  `<deckId>.webp` files as inert bytes; they are safe to delete by hand and no code path opens
  the folder. That is deliberate rather than unfinished — removing a directory of unknown
  contents means a recursive delete, and taking the recursive delete out of the deck path — see
  `reset.rs`'s module doc and [web-target.md](web-target.md), which records the run of it that
  ate a working tree — is one of the things this change is *for*.
- **The CSP did not change when the route arrived and did not change when it left, and that is
  the point.** `img-src 'self' data: mtgimg: http://mtgimg.localhost` covered a fifth _path_ for
  free; a route is not a source. `images::tests::the_shipped_csp_is_untouched` still pins the
  exact `img-src` and **outlived the route it was written for**, because serving any picture from
  `file:`, `asset:` or a `blob:` would be the same change and would still be the one nothing else
  in the app notices. What it no longer asserts is that the policy never mentions `cover` — there
  is nothing left for that clause to be about. Measured 2026-08-11 in the shipped window, while
  the route existed: with no file on disk the URL errored, and after one `deck_set_cover_image`
  the same URL loaded **626×457 in 2 ms**.

## The protocol and the CSP

- Card images are served over `mtgimg://` — `<origin>/<variant>/<card_id>/<face>`, where
  the origin is `http://mtgimg.localhost` on Windows and `mtgimg://localhost` elsewhere.
  Variants are **WEBP only** (`thumb`/`grid`/`display`/`art`); the JPG/PNG family is never
  fetched. The handler reads through `db_read`, never the write connection. `app.security.csp`
  is not `null` any more — a new remote source needs a deliberate edit and the
  `the_shipped_csp_allows_ipc_and_images_and_nothing_wild` test updated with it.
