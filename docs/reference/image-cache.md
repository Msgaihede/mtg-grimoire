# Image cache

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Files live at `<data dir>/images/<variant>/<id[0..2]>/<id>-<face>.webp`; `image_cache`
  rows and files stay 1:1, and the row's `source_uri` — Scryfall's `?<epoch>` cache-buster
  — is the only invalidation signal. Deleting `data/images` is always safe. **Since 2026-09-28
  something holds the 1:1 from the row's side too**: the eviction pass (below) drops a row whose
  file has gone, which is what lets the pre-warm fetch an owned card back after that delete.
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

  **The +50% per card is the wall-only case and the worst one.** The open card's art and the
  printings preview were already on `display`, so a card the reader opens used to cost two
  cache keys (~62 KB + ~93 KB) and now costs one. Cards already cached at `grid` were **not
  migrated or deleted** — a variant is its own directory, so the old files simply stopped being
  read. Every such card re-fetches once at the new URL; nothing paces that and
  `cards.scryfall.io` has no rate limit. **Until 2026-09-28 the old files then stayed until the
  reader deleted `data/images`, and now they age out** — not by a deleter written for them, but
  by the idle horizon in the bounded-cache bullet below. `grid` is not a dead variant: the home
  page's recently-viewed tiles (`RecentCardsWidget`) still draw it, so the files they read stay
  fresh and the rest go.

  Scryfall's `png` (745×1040) is larger still and was rejected: ~11% more linear resolution for
  roughly ten times the bytes, and it is not in the database at all — the ingest keeps four of
  the eleven image keys and drops the JPG/PNG family Scryfall's own docs mark as *replaced*
  (`card_row::webp_uris`), so it would need a schema migration and a backfill.
- **The cache is bounded since 2026-09-28, and what it spares is exactly what the pre-warm owns.**
  Until then nothing deleted a picture but the reader, and spec §8 called the cache *permanent*.
  `images::evict` now runs on an `image-upkeep` thread (`images::spawn_upkeep`, started beside the
  facet index in `desktop::start`): one pass a minute after launch, then another whenever **500**
  pictures (`STORES_PER_PASS`, ~46 MB at `display`) have landed since the last — a store is the
  only thing that grows the cache — and never while a sync holds the write connection.

  **Spared is every card in the collection, the wishlist or a deck, face 0, at the variant the
  pre-warm fetches it at**, and it is read from the same `WANTED` literal `prewarm_keys` reads.
  The sharing is the contract: the one eviction that costs more than a re-fetch is a picture the
  pre-warm wants and the budget does not, which the next pre-warm fetches back and the next pass
  deletes, for the life of the install, with nothing saying so.
  `the_spared_set_is_exactly_what_the_prewarm_would_fetch` pins it. Spared pictures are **outside**
  the budget — a collection is bounded by what the reader owns, which is spec §5's scoping
  argument — so a 10,000-card collection (~930 MB at `display`) never pushes the reader's
  browsing out behind it. Everything else — the search walls, the printings dialog, the backs of
  double-faced cards, deck covers' `art` crops, the recently-viewed `grid` tiles — is
  least-recently-used against two limits.

  **The budget is 512 MiB** (`CACHE_BUDGET_BYTES`, ≈ 5,770 `display` images at ~93 KB). It is
  2.9× one pre-warm pass (`MAX_PREWARM` × 93 KB = 186 MB, which a `const` assertion keeps it
  above, though the pre-warm's set is spared whatever the number); it holds the All tokens wall
  below (4,357 tiles, ~405 MB at `display`) whole, so scrolling to the end and back does not
  evict the top on the way down; and it is above the whole cache measured on 2026-08-20 —
  329.7 MB, owned cards included.

  **That last figure is why there is a second limit, and the second one is what reaches the old
  `grid` files.** A reader whose whole cache sits under any sane budget would never have lost one
  of them to a size limit. So an unspared picture unread for **90 days** (`MAX_IDLE`) goes, budget
  or no budget. A choice rather than a measurement: it trades disk against one re-fetch (~127 ms
  cold, from a host with no rate limit) of a card the reader returns to after a season away. The
  files the 2026-08-20 move left were last written that day or before, so the last of them go at
  the first pass after **2026-11-18**, sooner under the budget.

  **The used-stamp is each file's modified time, written on purpose, and not a column — so no
  schema rung.** `image_cache` is on the corpus side, and the corpus is the file this app deletes
  and rebuilds when it will not open or a rung fails; the rows go with it and the files stay. An
  evictor that read the rows could not see those files at all, so the bound it kept would be the
  one a rebuilt corpus quietly escapes. The pass walks the disk instead, which it needed to do
  anyway, and on Windows the directory listing carries each file's size and modified time — the
  standard library documents `DirEntry::metadata` as making no extra call there — so the walk is
  one listing per shard directory and nothing per file. **Nothing waits on the operating system
  to update a timestamp by itself**: last-access times are off on most Windows volumes and are
  never read. `store` sets the stamp by writing the file; a hit adds its key to an in-memory set —
  one uncontended mutex, no I/O, never the write connection — and the upkeep thread writes those
  stamps once a minute, opening each file with `write` and **never `create`**, because an empty
  file under a row that vouches for it would be served as a zero-byte picture. The module header's
  "no mtime" rule is about *freshness* and is untouched; a FAT32 stick rounding a stamp to two
  seconds moves a picture in a queue measured in days. What the stamp costs: it lags by up to a
  minute and a quit loses that minute's; the webview keeps a served picture a day
  (`max-age=86400`), so the stamp's resolution is about a day, and the horizon is ninety of them;
  and a folder copied by a tool that does not keep modified times starts every stamp at the copy,
  so for ninety days after such a move only the budget evicts.

  **File first, then its row.** Every interruption — a crash, a sync holding the write connection
  past the pass's one-second wait — leaves a row outliving its file, the supported state
  `reset::clear_cache` leans on too, and the next pass reaps it. The other order leaves bytes no
  row vouches for, which nothing serves. The row delete is guarded by `fetched_at` < the pass's
  start, so a picture re-fetched mid-pass keeps its new row. **Reaping** is the pass's second job:
  a row whose file the walk did not find is dropped, which is what lets a reader who deleted
  `data/images` have the collection warmed again — before, the pre-warm's `NOT EXISTS` read those
  rows as pictures on disk, forever.

  **Never deleted**: anything the walk did not parse as `<variant>/<id[0..2]>/<id>-<face>.webp` and
  rebuild through `cache_path` — a crashed store's `.tmp`, a file in the wrong shard, a folder that
  is not one of the four variants, anything a person put there; a spared picture; one whose row is
  still owed in `Cache::pending`, because it has only just landed; one the filesystem cannot date.
  A walk that errors on anything but a missing directory deletes nothing, because a partial walk
  would reap the row of every file it missed. `the_walk_never_deletes_a_file_it_did_not_parse_as_its_own`
  is the fence, and it is there for the `covers` incident's reason — see `/cover/` below.

  **Measured on Linux only, which is not a figure for this app** (2026-09-28, a debug test
  binary, a container's temp directory, 5,540 files of 60 KB with rows): the walk **34 ms**, a
  pass deleting 3,379 idle files and their rows **91 ms**, a pass with nothing to do **17 ms**.
  Nobody has timed a pass on Windows or against a real cache.
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

  So `CardImage` watches for silence: a frame **on screen** that has heard nothing by
  `IMAGE_STALL_DEADLINE_MS` re-requests with a `?stall=N` mark, twice, then dispatches `error` on
  the element so the ordinary backoff takes over. The mark is a query string and `images::serve`
  parses only the path, so nothing between the renderer and the handler can answer the second ask
  out of what it made of the first.

  **On screen, not merely laid out, since 2026-09-28 — and the difference emptied a wall.** The
  clock used to start at mount, gated at each tick on `getBoundingClientRect().width > 0`. A lazy
  picture below the fold has a box and has never been asked for, so its silence was read as the
  dropped message: asked twice more and handed to `error`, it drew "No image" for good. The live
  pass on the All tokens wall (debug build, real data, 4 357 tiles) counted **1 691** frames
  reading "No image" 40 s after the wall opened — five of six on screen after a scroll to the
  middle, none recovering in 20 s, every one a picture that loads at once when it is on screen at
  mount. The same pass found the gate's second cost: a `getBoundingClientRect()` per frame per
  tick is a forced layout per picture, and the wall ran 100–150 ms frames for ten seconds after
  each full redraw. Now one shared `IntersectionObserver` watches every frame: entering the
  viewport (with a box) arms the deadline, leaving it disarms it and the next entry starts a
  whole one, and a frame that has loaded or been refused is not armed again however it scrolls.
  Nothing measures the layout; the observer's entry carries the box. Being on screen is also when
  a lazy picture is requested, so the clock starts when silence can mean something. **jsdom's
  observer never reports**, so no frame in the suite arms a timer — the old gate's floor, kept.

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

  **That last sentence was the clue, and the paragraph above drew the wrong conclusion from it.**
  The report came back on 2026-09-08 — the same screenshots, against a build carrying the whole
  watchdog. What could not be reproduced could not be reproduced because **the instrument was
  destroying the phenomenon**: `Page.captureScreenshot` forces a compositor frame, so a sweep that
  measures by screenshotting over CDP repairs a missed paint before it can read it. Every other
  instrument is blind for its own reason — the DOM reports the image loaded, the console is silent,
  `error_log` is empty, and jsdom decodes nothing. The failure is not in the fetcher, not in the
  protocol and not in `PostMessageW`: **the bytes arrive, Blink decodes them, and the frame is
  never painted.**
- **A picture that arrives is still not a picture that is drawn, and `decoding="async"` is why.**
  Measured 2026-09-08 in the shipped window (debug build, 1920×1080 client, the reader's own corpus
  and image cache) by driving real `mouseWheel` bursts and reading the **screen's own framebuffer**
  with Win32 `CopyFromScreen` — which, unlike a CDP screenshot, asks the app to paint nothing —
  correlated against each `<img>`'s own `complete`/`naturalWidth`.

  A blank frame measures **`sd 0`, `mean 24.09`**: the exact colour of the empty frame underneath,
  flat to the last sampled pixel, while its `<img>` reports `complete === true` and
  `naturalWidth === 672`. It is **not** a frame of latency — the same tiles measure flat again six
  seconds later with no CDP traffic in the gap and their rects unmoved. Three remedies, in order:
  a pointer move far away **does not** repair it, `Page.captureScreenshot` **does not** repair it,
  and moving the pointer **onto the tile** does. So it is a lost paint invalidation rather than a
  frame that was never scheduled, and only re-invalidating that element brings the picture back —
  which is exactly the reader's "they load as soon as I mouse over them".

  They arrive in **contiguous right-hand blocks that break at the same column on consecutive
  rows** — a vertical boundary through the wall, which is a raster region and not anything the app
  can address. That shape is what the reporter's own screenshots show: last two of six on the
  search wall, last three of seven in the printings dialog.

  **The A/B, both arms driven the same way.** `CardImage` now sets `decoding="sync"` before its
  props spread, and the ten call sites that used to pass `decoding="async"` by hand pass nothing:

  | Surface | `decoding="async"` | `decoding="sync"` |
  | --- | --- | --- |
  | Search wall | persistent blanks at passes **3, 4 and 11** (three runs) | **432** tile-measurements / 40 passes, **zero** |
  | `AllPrintingsDialog`, Forest (949 printings) | persistent blank at pass **13**, 231 measurements | **390** tile-measurements / 25 passes, **zero** |

  **`"sync"` rather than deleting the attribute.** Absent, the value is `auto`; that arm measured
  clean too, over a smaller sample, but `auto` is a heuristic that stays free to choose the async
  path for a larger image or under memory pressure. The bug is that the deferred-presentation step
  loses its paint, and `"sync"` is the one value that removes the step instead of betting on the
  heuristic avoiding it.

  **It costs nothing, which is the part that was expected to be a trade.** Same gesture (60 wheel
  bursts), same build, `Performance.getMetrics` plus a long-task observer: `sync` **47** long tasks
  / 2 985 ms / worst **79 ms** and `TaskDuration` **12.34 s**, against `auto`'s **48** / 3 288 ms /
  worst **128 ms** and **12.61 s**. Inside the noise and not slower — a 672×936 WEBP decodes in
  well under a frame, and the decode always had to happen. What `async` bought was never the
  decode; it was the right to show the frame without it.

  **Two traps for anyone measuring this again.** A CDP screenshot repairs the state it is trying to
  photograph, so pixels have to come from the framebuffer. And `getBoundingClientRect` reports a
  rect inside the viewport for a tile the dialog's own scroller has clipped away — hit-test with
  `document.elementFromPoint` first, or a printings dialog hands you flat dark pixels belonging to
  the page behind it and calls them blank tiles.
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
  `reset.rs`'s `clear_decks` doc; a mutation-test run once made `covers` resolve to `src-tauri/`,
  a cargo test binary's working directory, and deleted 93 source files — is one of the things
  this change is *for*.
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
  (**The light app's web build has no protocol**: the same path is asked of the app's own
  origin under `/mtgimg`, and a service worker answers it — the section below.)

## In a browser: Cache Storage, and a service worker

The light app's web host (phase 5, step 5.3, 2026-10-04) keeps its pictures somewhere else
entirely, and **nothing above this heading is true of it**: no `data/images`, no `image_cache`
row, no upkeep thread, no pre-warm, and `images::Cache` is not called at all. The code is
`src/lib/core/web/sw/`; what was driven and timed is
[light-app.md](light-app.md) §9.3.

- **Cache Storage rather than files.** `platform::files` refuses in a browser, so the core's
  cache there could only fetch a picture, serve it and count a store failure. The pictures
  are the service worker's instead, in one cache, **`grimoire-pictures-v1`** — not per build,
  because a deploy that threw the pictures away would undo the point of keeping them. The
  `v1` moves only when the *stored shape* does.
- **The address keeps the protocol's shape on the app's own origin**:
  `<origin>/mtgimg/<variant>/<card_id>/<face>`, built by the same `cardImageUrl`
  (`src/lib/images.ts`'s `imageOrigin` answers the origin by the build's mode). The cache key
  is that address **without its query**, so a `?retry=N` or a `?stall=N` is the same picture.
- **The engine says where a picture is, and the worker fetches it.** A service worker cannot
  reach the database Worker, so it asks the page that made the request, over a
  `MessageChannel`, and the page asks the engine's `card_image_source` — `images::image_source`,
  which is `resolve`'s rule whole and fetches nothing. The answer is `uri`, `missing` or
  `unknown`, and a `uri` is only ever one `image_uri::is_fetchable` passes. The worker applies
  the same host rule again before it fetches (`pictures.ts`'s `isFetchable`): the answer is
  data from a database a sync wrote.
- **A stored picture is a response rebuilt from its bytes, never the one `fetch` returned —
  and that is a rule with a measurement behind it.** A page's `img-src` is checked against
  the *response's* URL even when a service worker answered. Measured on the hosting step's
  branch in Chrome 154: Scryfall's own response, passed through, is refused by
  `img-src 'self'`, and only a response built from the bytes loads — it has no URL of its own
  and takes the request's. So the hosting policy's `img-src` needs `'self'` and no card host.
  Rebuilding is also what lets three headers ride on the entry: `Content-Length` at the size
  the body was measured, `X-Grimoire-Stored` (when, in Unix milliseconds) and
  `X-Grimoire-Source` (Scryfall's address, `?<epoch>` included — this cache's one
  invalidation signal, as `source_uri` is the desktop's).
- **The statuses are this protocol's**, so `useImageRetry` and `CardImage`'s watchdog heal a
  browser's refusals as they heal the desktop's:

  | | Answer |
  | --- | --- |
  | A picture in the cache | 200; the engine is not asked, so it draws offline and while a finish holds the engine |
  | `uri`, fetched | 200, stored |
  | `missing` | 200, the placeholder SVG the desktop serves, `no-store`, **never stored** |
  | `unknown`; a path under the prefix that is no picture's — the face is `0` or `1` and the variant one of the four; or a picture asked for **as a page** | 404 |
  | No page to ask, a page or an engine that does not answer, a 429 from Scryfall | 503 with `Retry-After` |
  | A fetch that failed, any other status, a 200 that is not a raster image, an empty body | 502 |

  A refusal is `no-store` and is never kept. **One ask per picture in flight** — this
  cache's single-flight — and the wait on a page is bounded at 20 s.
- **A 200 is not yet a picture, and a stored body is never a document.** The desktop serves
  fetched bytes under one constant type and never reads what the CDN called them; a browser
  serves what it stored again, on the app's own origin, beside the database. So three locks:
  only a response that declares a raster image (`pictures.ts`'s `PICTURE_TYPES`: WEBP, JPEG,
  PNG, AVIF — never SVG) and has bytes in it is stored; a navigation under `/mtgimg` is a 404,
  so a picture is drawn by an `<img>` and by nothing else; and every answer under the prefix
  carries `X-Content-Type-Options: nosniff`. An error page under a 200 would otherwise have
  been that card's picture until 3 000 newer ones pushed it out.
- **A Cache Storage that throws is no cache, not no picture**: the picture is asked for,
  fetched and answered, and only not kept.
- **The budget is entries, not bytes: 3 000, swept once the cache is past 3 100, oldest
  first.** Cache Storage answers neither a size nor an access time, and a ledger beside it is
  a second record that can disagree with the first — round one's counted 9 of 78 pictures
  after one wall. The count is the one figure the cache answers exactly (`keys()`), and the
  order is the cache's own insertion order. At `display`'s ~93 KB that is about 280 MB, as a
  ceiling rather than a target.
- **No used-stamp, but a weekly re-put.** A hit rewrites nothing. A picture stored more than
  **7 days** ago is served first and then checked against the engine: the same address puts
  the same bytes back under a new stamp — which moves it to the young end of the cache's
  order (a put over an existing key does; measured, Chrome 154) — and a changed one fetches
  the new picture. `missing` deletes the entry; **`unknown` leaves it**, because after a
  card-data clear or a replaced corpus the engine knows no card until the sync has run again.
  So the order is least-recently-used at a week's resolution, where the desktop's stamp has
  about a day's.
- **Nothing is spared, because nothing is pre-warmed.** The desktop spares what the pre-warm
  owns so that the two cannot fight. Neither `prefetch_images` nor `prewarm_collection` is in
  the core's command table (`src-tauri`'s `command_table::NOT_YET` has both), so a light host
  refuses them and there is nothing for a spared set to protect.
- **Settings' *Clear cache* is answered on the page**, from Cache Storage, in `CacheCleared`'s
  shape with `rows: 0`: entry by entry rather than `caches.delete`, because the worker holds
  the cache open, and the bytes are a sum of each entry's own `Content-Length`. The engine's
  `cache_clear` is not called — on this host it holds no picture.
- **`web:dev` draws no picture**, because the dev server registers no worker; `web:preview`
  does.

**Measured once** (headless Chrome 154.0.8037.95, Windows 11, 2026-10-04, the built app
against the real hosts — light-app.md §9.3 has the run): an uncached picture took 1.15–1.72 s
from mount to decoded, median 1.70 s, which is the fetch from `cards.scryfall.io`; a cached
one after a reload 22–27 ms; with the server stopped, 19–25 ms. All 105 requests the page
made were answered 200. **Not measured**: the sweep and the weekly re-check, which ran over a
fake cache only; a real eviction by the browser; any browser but Chromium. **Known and left**:
a picture is stored twice, in the HTTP cache and in Cache Storage.
