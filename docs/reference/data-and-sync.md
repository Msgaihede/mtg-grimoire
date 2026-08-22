# Data, schema and sync

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

- Data dir is `<exe dir>/data`, falling back to `%APPDATA%/com.mtggrimoire.app/data`.
  **Under `tauri dev` the exe is `src-tauri/target/debug/`, so the database is
  `src-tauri/target/debug/data/mtg.db`** — not `src-tauri/data/`. Delete that `data/`
  folder to force a clean first-run sync. All three locations are gitignored.
  **The fallback's folder name is the Tauri `identifier`, and the rename changed it** —
  `com.mtgcollection.tracker` → `com.mtggrimoire.app`. A machine that ran the v0.2.0
  _installer_ still has the old folder and its database; nothing migrates it, deliberately
  (portable copies keep `data/` beside the exe and are untouched). So "my collection is
  gone" after upgrading an installed 0.2.0 has exactly one cause and one fix: copy the old
  folder across.
- A sync yields ~116.6 k cards / ~1 050 sets from a 77 MB download. **Timings, measured
  2026-08-05 over three live forced syncs (debug build):** `checking` <1 s · `downloading`
  ~2.5 s · `ingesting` **~81 s** · `reclaiming` ~6 s · `sets` ~5 s — **92–99 s end to end**.
  Re-measured 2026-08-06 on the day's rotated bulk file: **93 s**, corpus **116,590**
  unchanged. Scryfall regenerates "once every 12–24 hours" in a 21:00–21:45 UTC window
  (`default_cards` at ~21:16), so a forced Refresh finds a genuinely new file about once a
  day; after that the ETag answers 304 until the next rotation, and the only way to make it
  ingest again is the `sync_meta` reset below.
  The old **44.8 s** figure predates schema v3: the ingest now gzips `raw` on the way in,
  and that is where the extra minute went. A run that finds nothing new is **1.8 s**.
- `mtg.db` was **2.02 GB** and is **547 MB** after the two things Plan 3 added: the one-time
  `compacting` conversion (which reclaimed a 996 MB freelist) and gzip `raw`
  (**622 MB → 235 MB**, 38 % of the original — not the quarter that was estimated). A
  full re-ingest afterwards leaves the file within 0.03 % of that and the freelist at **0**,
  which is the post-swap `incremental_vacuum` doing its job.
- The app never closes its SQLite connection, so a `mtg.db-wal` the size of the ingest
  (~857 MB) used to outlive the process. `RunEvent::Exit` now runs
  `PRAGMA wal_checkpoint(TRUNCATE)`, and `journal_size_limit` caps the file at 64 MB.
- A second launch inside 24 h makes **no network call at all** — the throttle returns
  before the ETag check and writes nothing, so `last_check_at` does not move.
- A **forced** Refresh skips only the throttle, not the ETag/`updated_at` check: if the
  bulk file has not changed it answers "Already up to date" in well under a second and
  emits nothing but a `checking` phase. To exercise a real ingest out of turn, clear
  `bulk_etag` _and_ `bulk_updated_at` from `sync_meta` — clearing the etag alone still
  short-circuits. That reset works, and it is the right tool for developing an ingest; it is
  the wrong tool inside a **smoke**, because a hand-written `sync_meta` makes every timing
  and every "what the app did on its own" claim afterwards a fiction. A smoke takes the
  ingest the day offers it, or does without one and says so.
- **The two halves of the reconciler run on different schedules, and that decides how a
  fixture is staged.** `reconcile::apply` — the `/migrations` poll — runs on _every_ finished
  run, the "already up to date" path included (`finish_unchanged` calls it deliberately: 304
  is the answer most runs get). `reconcile::sweep_orphans` runs **only after a real ingest**.
  So a merge can be exercised any time by deleting its `card_migrations` bookkeeping row and
  forcing a Refresh; an orphan flag needs the day's ingest.
- Searches keep answering through every second of a sync — 20 timed searches across one,
  every one correct, none stalled (that is what `db_read` bought).
- **A header press now costs _hundreds_ of milliseconds more than doing nothing, and
  `idx_cards_collapse` is why the gap grew.** Re-measured 2026-08-11 end to end through
  `invoke` on a **release** build over the live 107 346-row paper corpus, medians of five,
  collapsed (the app's own default) — with the uncollapsed figure beside it:

  | order                         | collapsed    | uncollapsed |
  | ----------------------------- | ------------ | ----------- |
  | **name** (the default browse) | **134.6 ms** | 32.3 ms     |
  | **price**                     | 134.8 ms     | 26.0 ms     |
  | `set`                         | **524.2 ms** | 609.0 ms    |
  | `rarity`                      | **489.7 ms** | 570.2 ms    |
  | `rarity+price`                | **512.4 ms** | 529.8 ms    |

  **The split is whether the sort's column is in the index.** `name` and `price_usd` are, and
  cost the browse and nothing more; `set_code` and `rarity` are not, and cost ~490–610 ms —
  which is `schema.rs`'s own note that widening the index with those two "left the sorts it
  was meant to help unchanged, because those cost row lookups rather than index reads".
  The 2026-08-09 table (`set` 313 · `rarity` 325 · `rarity+price` 339 · `price` 345 against
  **277 ms**) predates the index and **every number in it is superseded**, in both directions:
  the browse got ~2× cheaper and the two uncovered sorts got ~1.6× dearer, so a press that
  used to cost +36 ms now costs +390 ms. The earlier claim that this was a "fraction more"
  survived one rewrite of this bullet on nothing but plausibility; it was false when written.

- **Two keys joined that list on 2026-08-20 — `manaValue`, which orders by `c.cmc`, and
  `released`, which orders by `c.released_at`.** Both are reachable only from the search filter
  bar's sort picker: there is no column to press, the same way the collection's `added` has
  none. Collapsed, both are answered **in the group step** rather than after the join, which is
  why neither is in `REPRESENTATIVE_SORTS` — and both halves of that were checked exhaustively
  against the corpus rather than argued. `min(c.cmc)` is that group's one mana value, exactly:
  mana value is a fact about the _oracle_ card and the group key is
  `coalesce(c.oracle_id, c.id)`, so every printing in a group should agree — and
  **0 of 31 894 groups disagree**. And
  `max(c.released_at)` _is_ the representative printing's own date rather than an aggregate
  standing in for it, because `collapse_rep` picks the representative by `released_at` DESC
  before it reaches price or `id` — **0 of 31 894 groups** have the two differ. Both counts are
  of the corpus named in the next bullet, on the day it was read: strong evidence for a claim
  about the SQL's structure, not a proof of it.
- **Both new orders land in the _cheap_ class, and the four known ones were re-measured in the
  same process to place them.** Measured 2026-08-20 through read-only `node:sqlite`
  (Node v24.16.0) against the **debug** database at `src-tauri/target/debug/data/mtg.db`,
  Windows, over **98 323 paper printings legal somewhere / 31 894 collapse groups**
  (`is_paper = 1 AND legal_mask != 0` — the default browse). Prepared statement, two warm-ups,
  median of nine, first page of 50 at offset 0.

  | order                            | collapsed    | uncollapsed | path       |
  | -------------------------------- | ------------ | ----------- | ---------- |
  | `name` (control, index-covered)  | 105.0 ms     | 1.8 ms      | group step |
  | `price` (control, index-covered) | 96.8 ms      | 20.7 ms     | group step |
  | `set` (control, uncovered)       | 578.6 ms     | 748.3 ms    | after join |
  | `rarity` (control, uncovered)    | 797.3 ms     | 767.7 ms    | after join |
  | **`manaValue`**                  | **147.2 ms** | **28.7 ms** | group step |
  | **`released`**                   | **152.2 ms** | **29.8 ms** | group step |

  Collapsed, the two new orders are **~1.4–1.5×** the `name` control, against **~5.5–7.6×**
  for the pair that runs after the join: pressing `Mana value` or `Released` costs tens of
  milliseconds where a `set` or `rarity` press costs hundreds. Uncollapsed they are ~29 ms
  against the control's 1.8 ms — both columns ride in `idx_cards_collapse` but **neither leads
  it**, so neither order can be read off an index and each is a sort pass — and still ~25×
  under the uncovered pair. So it is the **group step** that puts them in the cheap class, not
  the "is the sort's column in the index" split above — the two rules agree on these two keys
  only because both columns happen to be in the index as well.

  **These figures do not belong in the table above and must not be compared to its numbers row
  by row.** The SQL was rebuilt from `search.rs` by hand — the same `collapse_rep`, the same
  group step, both correlated status subqueries — but it is **not** `run_search`: a different
  SQLite build, no IPC hop, no DTO serialisation, a debug database, and a different corpus day
  from the 2026-08-11 release session above. They were also taken on the **pre-fix** statement
  shape, the join still re-sorting every page by name — the defect the collapsed-sort bullet
  further down records — and whether restating the sort there moves them is unmeasured. The
  controls are the whole reason this session answers anything: it was taken to place two
  orders in a class, and it does that _internally_, against its own
  `name`/`price`/`set`/`rarity` numbers and nothing else. **The rows in the table above are
  still owed**, end to end through `invoke` on a release build, the way every row in it was
  earned.

- **"A text filter makes every sort cheap" is only true of a _narrow_ term**, and the old
  12–15 ms figure named none. Measured the same way, collapsed, over three breadths:
  `bolt` (45 matches) **4.4–4.5 ms** and the three orders indistinguishable; `dragon` (722)
  **68.7–77.6 ms**; `a` (capped at 5 000) **2 077–2 432 ms**. FTS narrowing first is real, but
  what it buys scales with how much it narrowed. No index was added _for sorting_: a
  multi-term sort cannot use one past its leading column, and `schema::swap_staging` drops and
  replays every index on `cards` on each sync. (**That sync's ~93 s is a debug figure**,
  measured 2026-08-05 under `tauri dev`; the one release first-run measured 2026-08-11 had the
  facet index answering `ready: true` 21 s after launch, which puts the whole opening sync
  inside ~20 s. Every "~93 s sync" in this file is the debug number until someone times a
  release sync end to end.)
- **The browse today: 27.4 ms uncollapsed, 131.8 ms collapsed.** Measured 2026-08-11 end to
  end through the shipped window over the live 107 346-row paper corpus — a **release** build,
  `invoke("search_cards")` from the webview, medians of nine after two warm-ups — which puts
  the IPC hop and the DTO serialisation inside the figure, unlike the `run_search` numbers
  below (25 ms / 145 ms). The two **corroborate** each other rather than decompose into each
  other: they are different sessions on different corpus days, and the pair straddles the
  `run_search` figures in _both_ directions (27.4 > 25, 131.8 < 145), so no per-call overhead
  can be read out of the difference. `idx_cards_collapse` is why both are what
  they are, and the stale 277 ms is what the uncollapsed one replaces.
  **Name the build**: the identical measurement on a _debug_ build is 38.4 ms / 181.6 ms.
  The gap is only ~1.4× because the work is inside SQLite, which is C compiled with
  optimisations either way — but a figure with no build named is still not a figure.
  **The collapsed browse's cost is the count, not the page**: at `limit: 1` it is 119.9 ms of
  the 131.8, because `TOTAL_CAP` walks the grouping until it has 5 000 cards.
- **The search collapses printings into one row per card, and `idx_cards_collapse` is what
  pays for it.** Measured 2026-08-11 through `run_search` itself (release build, read-only
  copy of the live corpus, medians of five): **today's un-indexed browse 397 ms** (`SCAN c`,
  a full table scan) → **25 ms uncollapsed** and **145 ms collapsed** with the index. The
  index is worth more than the feature it was added for — every uncollapsed search gets that
  16× for nothing — while grouping 107 337 rows into 37 553 costs ~120 ms on top. 14 MB,
  0.7 s per sync, and it lives in `schema::CARDS_INDEXES` like every other index on `cards`.
- **Time the query the app runs, not a transcription of it — and when a change adds an index,
  measure the before-state with the index too.** The first draft of that table was wrong in
  exactly that way: the uncollapsed baseline was taken before the index existed and the
  collapsed figures after, which credited the grouping with a 2.3× win the index had paid
  for. A `#[test]` calling `run_search` found it in one run.
- **v9 widened `idx_cards_collapse` to carry `legal_mask`, `cmc` and `color_identity`, and a
  filtered collapsed browse went 505 ms → 41 ms for it.** Measured 2026-08-11 over the live
  corpus: 455–505 ms without the three columns against 22–47 ms with them, because without
  them the filter predicate knocks the group scan off the index and into per-row lookups. The
  cost is **+0.89 MB** and **4 ms** on the unfiltered browse, which the paragraph above is
  about.
- **That win exists only because `filters.rs` stopped parsing JSON, and the index alone made
  things _worse_.** With the widened index in place, the same format-filtered collapsed browse
  is **40.6 ms** through `legal_mask` and **591 ms** through `json_extract` — slightly worse
  than the 505 ms before widening, because a wider index is a larger thing to scan when the
  predicate cannot use it. An index and the query that reads it are one change; shipping the
  first without the second buys the whole cost and none of the benefit.
- **The collapsed shape is a `GROUP BY` step that also computes the representative's id, then
  a primary-key join back.** The whole pick is **one fixed-width sortable string per row fed
  to `max()`**, with `substr()` slicing the winning `id` back off the end — which is what
  makes the join `JOIN cards c ON c.id = g.rep`, a primary-key lookup. That shape is 108 ms
  against 767 ms for joining on the group key and matching the composite expression a second
  time, and against **2 486 ms** for the obvious `row_number() OVER (PARTITION BY …)`, which
  stays slow even with the index. (Measured 2026-08-11, release build, Windows, when the
  string was just `coalesce(released_at,'0000-00-00') || id`. The comparison is between
  _shapes_ and the shape has not changed; what the wider string below costs to build is
  measured per marketplace two bullets down.)
- **The representative is the cheapest printing of the card's _latest release date_** — since
  2026-08-14. Before that it was simply the newest printing, ties to the greatest `id`. Three
  keys over the printings that **matched the search**: `released_at` DESC (NULL coalesced to
  `'0000-00-00'`), then **price ASC at the reader's marketplace**, then `c.id` DESC. Each is
  one fixed-width segment of the `max()` string, and the price segment is written **inverted**:
  `max()` takes the _greatest_ string, so the cheapest price has to encode as the largest
  segment, and an unpriced printing encodes to the losing extreme so that a NULL loses to every
  priced printing instead of winning by default. `search::COLLAPSE_REP` is the one spelling,
  and the segment widths and the `substr` offset live there.
- **"The latest set" is resolved by price, not by set code, and that is the deliberate part.**
  Every candidate shares the card's latest release date, so every candidate sits in a set
  released on that date — and **2 503 of 37 556 paper groups have a latest date spanning more
  than one set**, so the case is common enough to decide on purpose. Where two sets tie, the
  cheapest printing across both wins. A `set_code DESC` tie-break was written, measured and
  **rejected**: promo sets are `p`-prefixed (`piko`, `pneo`, `pkhm`) and so sort _above_ their
  parent set, which handed a same-day tie to the promo printing — usually the dearer one.
  Icebreaker Kraken went `khm 63` **$0.36** → `pkhm 63p` **$0.88** under that variant, which is
  a rule called "cheapest" making the row more expensive.
- **The change moves 4 011 of 37 556 groups (10.7 %) and makes none of them dearer.**
  Measured 2026-08-14 on the live database (Windows, 116 703 cards, 37 556 paper oracle groups,
  TCGplayer prices). **0 of the 4 011 get a dearer representative** — a property of the key
  rather than a lucky sample, because every printing the old rule could have picked is still a
  candidate, so the one chosen is never more expensive than it. **163** go from an unpriced
  representative to a priced one, closing an em dash on a card that has a price. **1 155** of
  the changes cross a set boundary inside the same release date: `pfrf 143s` $2.59 →
  `frf 143` $0.35, `peld 185s` $0.82 → `eld 185` $0.34.
- **The pick is therefore marketplace-dependent — switching marketplace can change which
  printing represents a card.** That is consistent rather than surprising: a `SearchRequest`
  already carries a `marketplace` and the frontend already has it in the query key, and a
  collapsed row that offers the cheapest way to own the card has to mean cheapest _where the
  reader shops_. `COLLAPSE_REP` is a **function** of `sorting::printing_price_expr`'s output
  for that reason and not a constant any more. **Only `c.price_usd` is a column of
  `idx_cards_collapse`**, so the group step stays a covering scan at TCGplayer and pays row
  lookups (Cardmarket) or a correlated subquery into `marketplace_prices` (Card Kingdom, Mana
  Pool) at the other three — the same asymmetry `printing_price_expr` already carries for the
  price _column_, now owed by the _grouping_ as well.
- **What the third price evaluation costs, per marketplace.** The group step evaluated the
  price expression twice (`min`, `max`) and now evaluates it three times. Measured 2026-08-14
  against the same 563 MB database, timing the two-step collapsed query with **no filter** —
  the worst case there is, because every one of the 37 556 groups is built before the `LIMIT`:

  | Marketplace                                              | Old rule | New rule     |       |
  | -------------------------------------------------------- | -------- | ------------ | ----- |
  | TCGplayer — `c.price_usd`, in `idx_cards_collapse`       | 108 ms   | **127 ms**   | 1.18× |
  | Cardmarket — `c.price_eur`, row lookups                  | 548 ms   | **577 ms**   | 1.05× |
  | Card Kingdom / Mana Pool — `marketplace_prices` subquery | 891 ms   | **1 044 ms** | 1.17× |

  A **narrowed** browse — anything a reader actually types — is a wash: `name LIKE '%dragon%'`
  is 24 → 24 ms at TCGplayer and 27 → 28 ms at Card Kingdom. So the whole cost is the
  unfiltered browse's: **~19 ms** where the price expression is an indexed column, **~150 ms**
  where it is a correlated subquery. `EXPLAIN QUERY PLAN` still opens
  `SCAN c USING COVERING INDEX idx_cards_collapse`: the wider string did not cost the covering
  scan.

  **Provenance, and its limit.** Medians of old and new run **interleaved** (15 pairs
  unfiltered, 40 narrowed, 9 for the feed), because run-to-run drift on this machine is wider
  than the effect being measured — a first, non-interleaved pass had the narrowed browse
  getting _faster_, which it does not. Taken through Python's SQLite **3.40.1** against the
  app's own database file rather than through the crate, so these figures are comparable _to
  each other_ and not to a release-build number — the reason to trust the pair is that the old
  rule's 108 ms lands exactly on the release-build figure above. **The feed row is
  against 116 314 _synthetic_ `marketplace_prices` rows**, because no feed had ever been synced
  into this database: the row count is realistic, the prices are not, and only the timing is a
  fact. The ~900 ms the feed marketplaces already cost unfiltered is **pre-existing** and had
  never been measured before — `sorting::printing_price_expr` says so in as many words — and it
  dwarfs what this change added to it.

- **The group key is `coalesce(c.oracle_id, c.id)`, and the status subqueries must _not_ be.**
  `oracle_id` is nullable, so a bare `GROUP BY c.oracle_id` merges every null-oracle printing
  into one card — silently, with a printing count and price range spanning unrelated cards.
  Null-safety costs 69 ms and no live row needs it (0 of 116 590); it is spent because the
  failure is invisible. But `owned`/`wishlisted` probe **`c.oracle_id` on the joined
  representative row**: written against the group key instead they cost **1 514 ms** on the
  browse and **12 729 ms** on the rarity sort, because `coalesce(…)` is not indexable and all
  37 553 groups then re-scan `cards`. An _expression_ index does not rescue it either —
  SQLite scans one but will not treat it as covering (700 ms).
- **`bm25()` cannot be aggregated.** `min(bm25(…))`, the same expression in a subquery, and an
  ordinary CTE all fail with _"unable to use function bm25 in the requested context"_; only
  `WITH … AS MATERIALIZED` works, so that keyword is load-bearing syntax. FTS5's `rank` column
  _does_ aggregate and carries the table's default weights, which would silently discard this
  app's 10× name weighting. The CTE is built **only for ranked searches** — wrapping an
  unranked browse in a `MATERIALIZED` CTE would materialise all 107 k paper rows.
- Collapsed, `set`/`rarity`/`type` are the **representative's** columns, so the group step
  gives up its `LIMIT` and the sort runs after the join; name, price and — since 2026-08-20 —
  `manaValue` and `released` are answered inside the grouping. **But the grouping answers only
  _which_ groups reach the page, never the order they arrive in** — the outer join carries its
  own `ORDER BY`, and unless that restates the sort the page comes back in name order. It did
  not restate it until 2026-08-20, and the older wording here ("name and price are answered by
  the grouping itself") read as though it did: **right rows, wrong order**, on every collapsed
  search the group step answered but name-ascending. Reproduced against the live database
  2026-08-20 — price DESC returned the ten dearest groups listed alphabetically, and name DESC
  the Z-end of the corpus presented ascending. The mechanism stands; **its numbers are
  superseded and must not be quoted** — the 670 ms unfiltered figure by the end-to-end table
  above (collapsed `set` 524.2 ms, `rarity` 489.7 ms), and "88 ms with any text" by the
  breadth bullet above, which is the finding that a text filter's help scales with how far it
  narrowed (4.4 ms on `bolt`, 69–78 ms on `dragon`, 2.1–2.4 s on `a`). One mid-breadth term is
  not "any text".
- **Art series outrank the card they depict, and collapse does not fix it.**
  `Lightning Bolt // Lightning Bolt` (`astx 76s`, `layout='art_series'`) held the phrase twice
  in its name field and bm25 rewarded it; art series carry their own `oracle_id`, so grouping
  leaves them as their own rows. One `CASE` term at the front of the **relevance fallback
  only** fixes it at 0.2 ms — a ranking nudge, never a filter, and an explicit sort is left
  exactly as the reader asked for it. `min()` over that term is exact because no oracle group
  mixes the two kinds: 3 610 groups are represented by an art or token row and **0** of them
  also contains a real printing.
- **The default browse used to be a full table scan, and one `DESC` was why.** (Superseded as
  a _number_ — it was the 277 ms above, and `idx_cards_collapse` has since taken the
  uncollapsed browse to 27.4 ms — but the mechanism is unchanged and still decides the sort.)
  `ORDER_NAME`
  is `c.name ASC, c.released_at DESC` — `idx_cards_name` can satisfy a leading `c.name` and
  block-sort **one** trailing term within each group of identically-named printings, and with
  two it gives up and sorts all 107 k rows through a temp b-tree. Measured against
  `c.name ASC, c.id ASC`, which is what the Name column's own header sends: **0.1 ms, using
  the index**. The `released_at` term is kept deliberately — dropping it changes which
  printing of a card the browse opens on, which is a product decision and not a performance
  one — and `search::tests::the_default_browse_puts_the_newest_printing_of_a_name_first`
  pins the behaviour it buys.
- The page query keeps its flat shape. The two correlated status subqueries
  (`owned_quantity`, `wishlisted`) do run once per _matching_ row under an unindexed sort,
  but that is only ~35 ms of it (313 ms full vs 280 ms lean) — and the two-step form that
  would avoid them **does not preserve the sort's order**: `row_number() OVER ()` numbers
  rows before the `ORDER BY`, measured rather than read.
- The ingest **commits every 2 000 rows and releases the write connection between batches**,
  so a collection edit during a sync waits one batch, not one sync. `ingest_gz` takes
  `&Mutex<Connection>` for exactly that reason. **Measured mid-ingest: 10 `collection_add`
  calls, 4–7 ms each, 0 `BUSY` refusals.** A killed ingest therefore leaves a _committed_
  `cards_staging`; `prepare_database` drops it at the next launch, because the ETag that
  would short-circuit the next check is written only after a _successful_ ingest.
- `cards.raw` is a **gzip BLOB** from schema v3 (the column is still _declared_ `TEXT` — v1
  is frozen — and SQLite's TEXT affinity leaves a BLOB alone). `json_extract` over it is a
  hard error, not a NULL: read it with `CAST(raw AS BLOB)` and `card_row::raw_json`.
  Nothing reads it at runtime; `artist` has had a column since v3. The v3 migration does
  **not** rewrite existing rows — the corpus converts on the next sync's swap.
- **v13 adds one column — `decks.separate_x_group INTEGER NOT NULL DEFAULT 0`,
  whether a deck gathers its `{X}` spells under a heading of their own. Per **deck** and not a
  preference, for `theory_enabled`'s reason: it says how _this_ list is read, so a copy must read
  the same way and a second deck must be free to disagree; a global setting would have made
  opening one deck change the shape of every other. **The `DEFAULT` is the whole of the upgrade's
  promise** — `ALTER TABLE … ADD COLUMN` fills every existing row, so a user who has never heard
  of the switch opens their decks and finds them grouped exactly as they left them, and there is
  no backfill because there is nothing to compute. Nullable would have been three states for a
  two-state switch and a `coalesce` at every read site. It touches `cards` not at all, so it takes
  the same free pass v8, v9, v11 and v12 take below: it neither needs the `CARDS_INDEXES` replay
  nor takes it over, and no `cards_fts` rebuild is owed. **It was written as v12 and renumbered
  to v13 on the merge** — main's view-state step claimed the same number the same day — which
  is the ordinary weather of this ladder rather than an accident; v10's paragraph below is the
  standing warning. What the column _means_ is [decks-storage.md](decks-storage.md); nothing
  about the grouping it controls is in Rust.
  v12 adds three columns to `decks` — `last_variant`, `last_group_by` and
  `last_sort_by`, all `TEXT NOT NULL` with defaults `live`, `category` and `alphabetical` — so
  the deck editor reopens on whatever the reader was last looking at, per deck. Like v8, v9 and
  v11 it touches `cards` not at all, so it neither needs the `CARDS_INDEXES` replay nor takes it
  over, and it owes no `cards_fts` rebuild. None of the three is constrained in SQL — **and not because
  `ALTER TABLE … ADD COLUMN` cannot add a CHECK**, which is what this said until 2026-08-17 and
  is false (v19's `deck_cards.finish` adds one and it is enforced). The fence sits where the
  vocabulary is owned:
  `last_variant` against `schema::DECK_VARIANTS` in Rust, the other two narrowed in TypeScript on
  read — [decks-storage.md](decks-storage.md) has the reasoning.
  v11 adds `marketplace_prices` (`marketplace, card_id, finish, price`,
  `PRIMARY KEY (marketplace, card_id, finish)`, `WITHOUT ROWID`) and `marketplace_feed_meta`
  (`marketplace, fetched_at, feed_built_at, row_count`) for the Card Kingdom and Mana Pool
  price feeds. **They are tables and not `cards` columns because `swap_staging` drops `cards`
  on every sync**, and re-downloading 112 MiB of feed to restore a price column is not a
  recovery plan; `card_id` is a _soft_ reference with **no foreign key**, since a feed and the
  corpus are collected on different days and a price for a printing this database has never
  seen is the expected case. The step touches `cards` not at all, so — like v8 and v9 — it
  neither needs the `CARDS_INDEXES` replay nor takes it over, and it owes no `cards_fts`
  rebuild. See
  [the price-feed spec](../superpowers/specs/2026-08-12-marketplace-price-feeds-design.md).
  v10 adds `cards.legal_mask`, backfills it, and widens
  `idx_cards_collapse` to carry the filter columns. **Our step sits _below_ main's v8 and v9
  in the ladder deliberately** — it has now been renumbered **twice**, from v8 when main's
  deck-category step landed and from v9 when main's error log did, and each time it had to
  move _down_ the file as well as up in number. `migrate` reads `user_version` **once** and
  then walks every block above it, so a higher-numbered block placed above a lower one commits
  its version and then has the lower block write back over it. Position in the file is the
  order of execution; the number is only the gate. **Expect a third renumber**, and treat
  "renumber, then move to the bottom, then re-point the fixtures" as one operation.
  v9 adds `error_log` — see [scryfall.md](scryfall.md). v8 replaced `deck_cards.zone` with a
  user-owned category and added the deck's four new tables —
  [decks-storage.md](decks-storage.md) describes it.
  v7 is the collapse index's version and has **no statements of its own**: `CARDS_INDEXES`
  describes the table _at head_ and now names `legal_mask` and `illustration_id`, so **only the
  newest step may create from that list**, and every step below the current holder creates no
  index at all. Every statement in it is `IF NOT EXISTS`, which is what makes that replay "bring
  the index list up to date" rather than a rebuild — but a step that _changes_ a definition must
  `DROP` it first, or the
  widening is a silent no-op on exactly the machines that need it. (v6 added `app_meta`; the
  paragraph below describes v5.)
- **`app_meta` gained `deck_driven_collection` on 2026-08-22, and it needed no rung to do it** —
  which is the whole point of a key/value table at schema v6. `"1"` / `"0"`, written by
  `deck_driven::store` and read by `deck_driven::stored`; a missing row, a junk row and a row a
  newer build wrote something else into all read **false**, the hand-kept collection the reader's
  own rows are sitting in. It is the one key in this table that decides **what a query reads
  from** rather than how something is drawn, and the rule it gates is
  [deck-driven-collection.md](deck-driven-collection.md).
  **The census is `grep -rn 'get_app_meta\|set_app_meta' src-tauri/src`, not a list here** — a
  total written down in prose is a fact about a tree, and every open branch has a different one.
  Grep the *calls* rather than the `K_*` constants: `maintenance.rs` names two of those and both
  are `sync_meta` keys. What is worth knowing without grepping is the split: most of these rows are a
  reader's *choice* (`marketplace`, `printing_group_by`, `nav_collapsed`, `card_zoom`,
  `deck_search_open`, `deck_driven_collection`), one is a *memory* of what they last did
  (`last_deck_format`), and the rest are the app's own bookkeeping (the update check's three,
  `scryfall_penalty_until`). **None of them belongs in `sync_meta`** — a row in that one the sync
  did not write makes every later timing claim a fiction.
- **Schema is v22**, and `schema::SCHEMA_VERSION` is the answer — this line read **v18** for two
  whole rungs, because a prose-only edit routes to neither CI job and nothing goes red when a
  ladder entry rots.
  **v22 writes no shape at all — it repairs one column's contents**, and it is the first rung
  here that does. v20 added `oracle_tags.slug_norm` with `ALTER TABLE … ADD COLUMN`, which
  cannot add a `NOT NULL` column without a default, so every row an existing database carried
  over read `''`. That step argued the value was never read, because a refresh drops and rebuilds
  the taxonomy wholesale — and it is wrong by up to a week, which is
  `tags::oracle::REFRESH_INTERVAL_SECS`. `tags::query` matches every typed needle against exactly
  that column, so between the upgrade and the next refresh **every oracle tag search answered
  nothing**: no error, nothing in `error_log`, the rail still listing the tags the box could not
  find (it reads `slug`), and the art taxonomy — created empty by the same step, so ingested in
  full at the first launch — working perfectly beside it. That is
  [issue #180](https://github.com/Msgaihede/mtg-grimoire/issues/180), and it is the shape of
  failure a `DEFAULT` on a column only an ingest can fill will produce every time.
  `backfill_oracle_slug_norm` recomputes it through `tags::normalize` — **the same function the
  ingest writes the column with, and there is one copy of that rule deliberately**: a second
  normalisation spelled in SQL would leave both halves self-consistent, the search wrong, and no
  test in either half failing. It is also not expressible in SQLite, which cannot walk a string
  to strip non-alphanumerics. Recomputed rather than waited for because a refresh is not
  something this app can promise: a machine that cannot reach Scryfall is a supported state.
  **`oracle_tags.id` is deliberately not backfilled and cannot be** — it is Scryfall's uuid and
  nothing derives it — so a mute stays refused-in-words until the next refresh, which is the
  state `tags::query::not_muted`'s `id <> ''` clause and `tag_mute`'s refusal already exist for.
  **v21 rebuilds one table and takes one column off it**, and both halves of that sentence are
  the feature: `deck_tags` loses `deck_id` and gains `name_key`, so a tag belongs to no deck and
  its grain (`DECK_TAG_GRAIN`) becomes one name, app-wide. `tag_name_key` is what "one name"
  means — NFC, Unicode lowercase, NFC again — computed in Rust and **stored**, because SQLite
  cannot answer it: `COLLATE NOCASE` folds ASCII and nothing else, and the bundled build carries
  no normalisation at all. That is the one dependency the rung added, `unicode-normalization`.
  **Three things about the step are worth knowing before touching it.** The survivor of a merge
  is the row worn by the most **copies** (then `updated_at`, then the lowest id) and it **keeps
  its own id**, so every `deck_cards.tag_id` and every audit row that already named it still
  does — only the losers are remapped. The rebuild carries the labels across the drop **by hand**
  (`deck_tags_carry`), because under `PRAGMA foreign_keys=ON` a `DROP TABLE` on a *parent* runs
  an implicit `DELETE FROM` that fires `deck_cards.tag_id`'s own `ON DELETE SET NULL` — which
  would untag every card in every deck and leave a perfectly-shaped empty answer behind it — and
  the pragma cannot be turned off to dodge that, since toggling `foreign_keys` is a documented
  no-op inside a transaction and `migrate` is always inside one. And it **deletes every
  `deck_undo` row**: a step names tag ids (`Op::Tags` directly, every *card* step through
  `CardRow::tag_id`), so one could restore a card's label as a foreign key resolving to nothing,
  or re-insert a name another deck now holds, which the new grain refuses. `deck_audit` is left
  alone — the history still reads in full, and only the arrows lose their charge, once.
  v20 adds **six tables, two columns, five indexes and a replay that moved**, and every one of
  them is named below — a bare count is the thing that rots here, and a list is not.
  Five of them: `art_tags`, `art_tag_parents`, `art_taggings`, the closure `art_tag_illustrations`
  and the watermark `art_tag_meta` — Scryfall Tagger's *art* taxonomy, a parallel set rather than
  a `kind` column on the oracle five, because an art tag is a fact about an **illustration** and a
  single table would need a key that is an `oracle_id` on some rows and an `illustration_id` on
  others. The sixth is the user table `muted_tags` (`namespace, tag_id, slug, muted_at`),
  deliberately outside both `*_TAG_TABLES` lists: those are what a refresh drops and rebuilds
  wholesale, and a reader's mutes must survive one.
  The two columns are `oracle_tags.id` and `oracle_tags.slug_norm`, both
  `TEXT NOT NULL DEFAULT ''` — the default is what makes `ADD COLUMN` legal on a `NOT NULL`
  column, and it is why `tags::query`'s not-muted clause is `{alias}.id <> ''`: without that
  fence one `muted_tags` row with an empty `tag_id` would equal every un-refreshed row and take
  the whole oracle taxonomy off the page silently. Neither staging twin carries the default.
  The five indexes are `idx_cards_illustration`, which joins `CARDS_INDEXES`, plus the **four**
  in `TAG_INDEXES_SQL`: `idx_art_tags_norm` and `idx_oracle_tags_norm` over the two `slug_norm`
  columns the type-ahead matches against, and `idx_art_tag_illustrations_slug` and
  `idx_oracle_tag_cards_slug` over the two closures the reach count scans. **Those two
  constants are the census** — read them rather than this sentence. The arithmetic that keeps
  the number honest is `UNDO_V20`'s: three of the five come down by hand and two ride along on
  the `art_*` tables being dropped. The four sit beside the tables rather than in them, because
  both live tag tables are renamed over by a swap.
  **This sentence said *three* on the day it was written**, and it is worth leaving the scar:
  the paragraph below it already said four, `UNDO_V20` already said five, and the count still
  went in wrong — inside the entry that opens by warning about exactly this. A number nobody
  can go red over is a number to name a constant instead of writing down.
  **And v20 takes the `CARDS_INDEXES` replay over from v10** — the ladder's standing rule, since
  the list describes `cards` at head and v20 is the newest step to touch it. A database sitting
  anywhere above v10 would otherwise never be handed `idx_cards_illustration`.
  **`TAG_INDEXES_SQL` is also replayed at the tail of `migrate`, outside the ladder and from every
  version, and that one is fatal** where `prepare_database`'s other repairs merely log. The reason
  is a measurement rather than caution: `tags::query` counts a tag's reach with a correlated
  `count(*)` over the closure — **49 ms** with `idx_art_tag_illustrations_slug` and **531 seconds**
  without it, 11 531 candidate tags against a 951 499-row scan each, on a release build
  2026-08-20. A database missing it does not get a slow Tags page; it gets a window that stops
  responding on the first keystroke in the tag box, and nothing about that symptom points here.
  A rung fires once and in one direction; an interrupted swap, a restored older data folder or a
  future rename all lose an index a rung already spent. Every statement is
  `CREATE INDEX IF NOT EXISTS`, so an ordinary launch pays four catalog lookups.
  The corpus figures behind all of it:
  [the art-tags research](../superpowers/research/2026-08-20-scryfall-art-tags.md).
- v19 adds one column and rebuilds one index — `deck_cards.finish`
  (`NULL | 'foil' | 'etched'`, CHECKed) and `idx_deck_cards_grain` widened with
  `coalesce(finish, '')`. **A deck card names a finish**, which reverses the rule that had held
  since v5: foil is a *finish of a printing* in Scryfall's model rather than a printing, so
  53 224 of 107 337 paper printings carry one under the same id and wanting the shiny copy was a
  thing the model had no way to say. **No backfill** — the column is nullable and NULL is the
  regular copy, which is what every existing row already meant — and the `coalesce` is
  `COLLECTION_GRAIN`'s device for its reason: SQLite treats NULLs in a UNIQUE index as
  *distinct*, so the bare column would have stopped every regular add folding into the row
  already there. It is the **first rewind on this ladder that has to drop an index first**
  (SQLite refuses `DROP COLUMN` on an indexed column), so `UNDO_V19` is three statements, and
  `DECK_CARD_GRAIN` leaves
  `every_plain_grain_constant_names_the_index_the_head_schema_carries` to join the two grains
  held to their indexes by their `ON CONFLICT` targets instead. **It also settles a claim this
  file made twice**: `ALTER TABLE … ADD COLUMN` *can* carry a CHECK, and it is enforced — which
  is why the v18 entry below no longer gives that as the reason its own two columns have none.
  **It was written as v18 and landed as v19**, which is this ladder's own collision rule doing
  its job: the game columns were written on another branch against the same head of 17 and
  merged first. The whole design:
  [the spec](../superpowers/specs/2026-08-17-deck-card-finish-design.md).
- **v18 adds two columns and re-seeds one table** —
  `format_specs.games TEXT NOT NULL DEFAULT 'paper,arena,mtgo'` (which platforms each format is
  playable on, a comma-joined list of `schema::GAMES`) and
  `decks.game_key TEXT NOT NULL DEFAULT 'any'` (which platform a deck is for, `schema::DECK_GAMES`).
  The deck's answer is a **filter over the format picker** and nothing else: it narrows which
  formats every format select offers, and `pickerFormats`' `keep` folds the deck's own format
  back in, so a Modern deck set to Arena still says Modern. Rust supplies both facts and draws
  no conclusion; the narrowing is `src/features/decks/useFormatSpecs.ts`'s.
  **`'any'` is a stored sentinel rather than a NULL**, `default_category_id`'s argument one rung
  down: `DeckPatch` writes `coalesce(?n, column)`, so a bound NULL means *leave it* and a
  nullable column could never say "back to Any". Neither column carries a CHECK — not because
  `ADD COLUMN` cannot add one, which is what this said until v19 and is false, but because the
  fence belongs where a caller can reach: `deck::valid_game` is Rust's on the one of the two a
  command parameter reaches, and `format_specs.games` needs none because only the seed writes it.
  **The step also forced the format seed to split in two.** `FORMAT_SPECS_SEED_V5` is now frozen
  history — what v5 wrote, replayed by every fresh install long before this column exists — and
  `FORMAT_SPECS_SEED` is head, carrying `games`, re-run here with `INSERT OR REPLACE`. Leaving
  one constant was not available: a head seed naming `games` fails at v5 on a new machine, and a
  head seed *not* naming it would silently reset every row's platforms to the DDL default the
  next time a migration corrected any other cell.
  `the_head_format_seed_agrees_with_v5_on_every_shared_cell` compares the two column by column,
  which is what keeps the split from becoming two opinions about the other fifteen cells.
- v17 adds one table — `deck_undo`, the deck editor's undo journal: one step
  per deck write, keyed 1:1 to the `deck_audit` row it reverses, with a nullable `undone_at` that
  is the cursor. A **sibling** of the history rather than a column on it, because `deck_audit` is
  append-only and read whole every time the drawer opens while a step for a deleted category
  carries the rows the CASCADE took. Its DDL is `CREATE TABLE IF NOT EXISTS`, so `UNDO_V17` is
  owed for `UNDO_V14`'s quieter reason rather than `UNDO_V13`'s — a fixture that forgot it would
  still migrate, and would simply have stopped describing the version it is named for. The whole
  design: [decks-storage.md](decks-storage.md).
- v16 adds one column — `decks.default_category_id INTEGER NOT NULL DEFAULT 0`,
  **which of the deck's own categories an add that names no pile lands in**. It is the deck
  editor's old "Add to" answer, which lived in a `useState` in `DeckEditor` and a select on the
  docked search panel until 2026-08-15: a reader who pointed it at their Sideboard lost the choice
  the moment they closed the deck, and the _other_ surface it governed — the toolbar's quick-add
  field — drew no control at all. It is asked in the deck settings dialog now, beside the format
  and the folder.
  **`0` is `Auto` and is a value rather than an absence**, which is the whole of why this is a
  `NOT NULL` sentinel and not a nullable foreign key. Three things follow. `deck_categories.id` is
  an `INTEGER PRIMARY KEY`, so rowids start at 1 and no pile can ever collide with the sentinel —
  the frontend already rested on that, spelling it `AUTO_CATEGORY`, and Rust now spells the same
  number `deck::AUTO_CATEGORY`. `DeckPatch` writes `coalesce(?n, column)`, where a bound NULL means
  _leave it alone_, so a nullable column would have needed a command of its own to say "back to
  Auto" — `decks.folder_id`'s exact problem, and `deck::set_folder` is the price it pays. And **the
  cost is that `ON DELETE SET NULL` cannot do the clean-up**, so two sites do it by hand and are
  named at the step: `deck_meta::delete_category` puts a deck filing by the deleted pile back to
  `0` in the transaction that deletes it, and `deck::duplicate_deck` **remaps** the id onto the
  copy's own categories — a verbatim copy would point the duplicate at a pile of the original,
  which breaks nothing and files every add into a deck the reader is not looking at.
  **The `DEFAULT` is the whole of the upgrade's promise and there is no backfill**, because there
  is nothing to recover: the value it would recover was never stored anywhere, and every deck that
  predates the column opens exactly where the editor used to open. Rust owns one fence — a non-zero
  id must name a category **of this deck** (`category_of_deck`), since nothing in the DDL says so —
  and knows nothing about what Auto _does_: `autoCategoryFor` reads Oracle tags and is TypeScript's.
  The step touches `cards` not at all, so like v8, v9, v11, v12, v13, v14 and v15 it neither needs
  the `CARDS_INDEXES` replay nor takes it over, and owes no `cards_fts` rebuild.
- v15 adds `deck_categories.origin`
  (`TEXT NOT NULL DEFAULT 'user'`) — **who made the pile**: `'auto'` is the app, filing a card it
  had to invent a column for, `'user'` is the reader pressing "New category", and the four seeded
  zones count as the reader's. TypeScript hides an _empty_ `auto` pile and always draws a `user`
  one; Rust records the fact and concludes nothing from it. **No CHECK** (`ALTER TABLE ADD COLUMN`
  cannot add one, `decks.last_variant`'s constraint) and **no Rust fence either**, which is the
  deliberate difference from `last_variant`: `origin` is never a caller's value — four INSERTs
  inside the crate write it (`deck_meta::category_for_name` → `'auto'`,
  `deck_meta::create_category` → `'user'`, `deck_meta::ensure_predefined_categories` → `'user'`,
  and `deck::duplicate_deck`, which **copies** the source pile's answer rather than re-deciding
  it) and no command parameter reaches it. **The point of storing it is that `category_for_name`
  finds before it creates**: `DECK_CATEGORY_GRAIN` is `(deck_id, name)`, so a reader's own "Ramp"
  is found rather than re-made and keeps `'user'` forever, which is exactly the case a rule driven
  off the _name_ — "Ramp", "Draw", "Removal", "Land" are what people call their own piles — gets
  wrong. The backfill is a **one-time frozen guess**: `kind = 'main'` plus one of the 22 names
  `autoCategoryFor` could answer with on the day it shipped (the 13 functional buckets, the 8 type
  buckets, `Uncategorised`), spelled as literals and deliberately **not** kept in step with
  TypeScript's list, for `PREDEFINED_CATEGORIES`' reason. **That divergence is real rather than
  theoretical since 2026-08-16**: the rule's fallback was renamed to `Uncategorized`, with a `z`,
  and this step still says `Uncategorised` because it is a record of what the rule answered on the
  day it ran — a machine that has already run v15 never runs it again, so editing the literal here
  would describe a backfill nobody performed. Nothing is stranded by the split: `category_for_name`
  writes `'auto'` for any pile it invents, so a `Uncategorized` pile made after the rename is
  marked correctly without this step's help. **`Main deck` is not on it** — that is
  the v8 migration's own pile, holding real cards. Both ways of being wrong are mild and
  self-correcting: a mis-marked pile either hides until a card is added or draws until the reader
  deletes it, and neither loses a card. The step touches `cards` not at all, so like v8, v9, v11,
  v12, v13 and v14 it neither needs the `CARDS_INDEXES` replay nor takes it over, and owes no
  `cards_fts` rebuild.
- v14 adds Scryfall's Oracle Tags: `oracle_tags` (`slug` PK, label,
  description), `oracle_tag_parents` (`child_slug, parent_slug` — **many parents per child**,
  684 of 4 521 tags have several), `oracle_taggings` (`oracle_id, slug, weight, annotation`)
  and `oracle_tag_cards` (`oracle_id, slug`), all four `WITHOUT ROWID` with no index but their
  own primary key, plus a one-row `oracle_tag_meta` watermark (`etag`, `updated_at`,
  `ingested_at`, `checked_at`, `tag_count`, `tagging_count`). **`checked_at` is separate from
  `ingested_at` for `sync_meta.last_check_at`'s reason**: a 304 leaves the rows alone, so only
  the "when did we last ask" stamp may move — without it a taxonomy that is simply up to date
  reads as due on every launch and spends one API call per start to learn nothing. `oracle_tag_cards` is the **closure** — every
  tag a card holds _and_ every ancestor of those tags, flattened once at ingest — and it is
  the only one the app reads at query time, as a prefix scan per card. Measured live
  2026-08-14 over that day's file: 4 521 tags · 926 roots · **684 with more than one parent** ·
  max depth 5 · no cycles and no dangling parent ids (neither of which the ingest assumes) ·
  229 633 taggings over 35 969 distinct oracle ids · `weight` is `median` on 99.74 % of them
  and nothing branches on it. `oracle_id` is a **soft** reference like every other reference to
  `cards` in this schema, and the step touches `cards` not at all — so, like v8, v9 and v11, it
  neither needs the `CARDS_INDEXES` replay nor takes it over, and it owes no `cards_fts`
  rebuild. The four tables are filled through `oracle_tag_*_staging` and promoted by one rename
  transaction that carries the watermark with it: a half-populated closure is the one state a
  reader must never see, because a card whose ancestors landed and whose siblings did not
  simply reads as not being in that category.
- **`legal_mask` is Scryfall's `legalities` object as one integer, and its key order is
  frozen.** `legalities::LEGALITY_KEYS` is 23 keys and bit _k_ is `LEGALITY_KEYS[k]` — **bit
  positions are stored data**, held in every `cards` row, so reordering the list silently
  reinterprets the whole corpus. Keys may only ever be **appended**: a key Scryfall removes
  keeps its bit and stops being set, a key Scryfall adds sets no bit until it is appended
  _and_ a sync has run. `restricted` counts as playable alongside `legal` — a Vintage search
  that hid Black Lotus would be wrong. It buys two things: a facet pass over the live corpus
  is **16.8 ms against 695 ms** for 23 `json_extract`s per row, and a JSON path cannot be
  indexed while a bitwise test on a column can. **Name the build**: that pair, and every
  other SQL figure this branch added (`filters.rs`'s 40.6/591 ms, `schema.rs`'s 455–505 →
  22–47 ms and +0.89 MB, `index/mod.rs`'s 2 238/62/106–167 ms) was timed 2026-08-11 through
  `node:sqlite` against a **page-for-page online backup** of the live database — SQLite's own
  C, which is compiled the same whether the caller is a debug or a release crate, so the
  fixture is the thing worth naming and a cargo profile would say nothing. It is derived natively by `card_row` from the
  next sync on, so the v9 backfill's `legalities::mask_sql` is the only time it is ever
  computed in SQL. **Verified live 2026-08-11 over the whole 116 695-row corpus**, both ways
  in: the migration backfill and a full fresh ingest each agree with `json_extract` on all 23
  keys, 0 rows disagreeing and 0 NULL masks.
- **Our `legal_mask` migration on a real database is ~7 s of launch, before there is a window
  to say so in.** Measured 2026-08-11 on the live 563 MB / 116 695-row file (debug build,
  67 MB WAL to replay), when the step was still numbered v9: `user_version` flipped **7.0 s**
  after the process started, and the app
  came up on the corpus rather than on "move `mtg.db` aside". That is process start, WAL
  recovery, the `ALTER`, the full-table backfill and the index rebuild together — the
  synthetic 469 MB stand-in the step's own comment quotes measured the backfill alone at
  2.9–5.0 s in a release build, and this is the first time the step has run against real data.
- **A migration that touches `cards` must take the `CARDS_INDEXES` replay from the step below
  it**, and `schema::tests::every_version_ends_with_the_same_schema_as_a_fresh_install` is
  what fails if it does not: it migrates a v1, a v6 and a v9 fixture to head and compares
  `cards`' columns _and_ its indexes — by stored SQL, since a narrow and a widened
  `idx_cards_collapse` share a name. **Since v12 it compares `decks`' columns too, in _ordinal_
  order** (`deck_columns`, `card_columns`' counterpart): `decks` has an `ALTER` ladder of its own
  now — v8's three columns, v12's three, v13's one, v16's one and v18's one — and every read of a
  deck row is
  **positional**, so a route that reaches head with the same column _set_ in a different order is
  a `DeckRow` reading the wrong fields with no error anywhere. **Since v15 it compares
  `deck_categories`' columns as well** (`category_columns`), for the half of that reasoning that is
  not about ordinals: mirroring `origin` into v8's `CREATE TABLE` so a fresh install "has it"
  breaks **only** fresh installs, because the v15 `ALTER` then hits a duplicate column — the one
  population no upgrade fixture can stand in for.
  **"Head minus one" is a title that moves between fixtures, not a fixture that is renamed.**
  `schema::tests::the_head_minus_one_fixture_really_sits_one_step_below_head` asserts
  `SCHEMA_VERSION - 1` so the claim and the constant cannot drift apart, and each new step hands
  the title on rather than renumbering the holder: v12 handed it to a new **`v11_database`**, v13
  to a new **`v12_database`**, v14 to **`v13_database`**, v15 to **`v14_database`**, v16 to
  **`v15_database`**, v17 to **`v16_database`**, v18 to **`v17_database`**, v19 to
  **`v18_database`**, v20 to **`v19_database`**, v21 to **`v20_database`** and v22 to
  **`v21_database`**. The fixtures it
  passes stay exactly where they are, each pinned to
  a literal because each proves something only a database genuinely _at_ that version can —
  `v11_database` to 11, so the step that adds the view-state columns has a database it can
  actually run over, and `v10_database` to 10 before it, for
  `the_v11_step_creates_the_marketplace_price_tables`. `v9_database` is a _different_ claim again
  and is pinned to the literal 9: it **was** the last version below the `CARDS_INDEXES` replay,
  and it kept its number when v20 took that replay over rather than following it — what only a
  pre-v10 database can show is a *narrow* `idx_cards_collapse` being replaced, which is a fact
  about version 9 and no other. `v19_database` is the last version below the replay now, and
  proving that a machine entering the ladder below it still ends up with every index a fresh
  install has is that fixture's job.
  **A rewind fixture may only undo the steps _above_ where it claims to sit — and it owes a line
  for every one of them whose DDL is not idempotent.** Every rewind fixture —
  `v9_database`, `v10_database`, `v11_database`, `v12_database`, `v13_database`, `v14_database`,
  `v15_database`, `v16_database`, `v17_database`, `v18_database`, `v19_database` — is built the
  same way, because
  only version 1's DDL is frozen and there is no way to _build_ a later database forwards:
  migrate to head, undo by hand, renumber. `migrate` then reads `user_version` once and walks
  every step above it, so each of those steps is **replayed** over the fixture.
  **The forward-built fixtures owe the mirror of that rule, and v18 is what made it bite.**
  `v1_database` and `v6_deck_database` are hand-written old schemas rather than rewinds, so a step
  *above* them that writes to a table they never created fails on them alone — and v18 writes to
  `format_specs`, which v5 creates and `v6_deck_database` had simply never bothered with. Four
  tests died on `no such table: format_specs`, none of them about games. The fixture creates the
  table now (v5's DDL as a literal, seeded through `FORMAT_SPECS_SEED_V5`), which is the same
  argument its own comment already made about the five `cards` columns it replays: a fixture that
  stopped at an earlier shape is a pre-v5 database wearing a v6 label.
  `CREATE TABLE IF NOT EXISTS` survives a replay; **`ALTER TABLE … ADD COLUMN` does not** — SQLite
  answers `duplicate column name`. That is why **every non-idempotent rung has to come back out of
  every rewind fixture below it** — v20's two `oracle_tags` columns, v19's `deck_cards.finish`
  (index first: SQLite refuses `DROP COLUMN` on an indexed column), v18's two game columns, v16's
  `decks.default_category_id`, v15's `deck_categories.origin`, v13's `separate_x_group`, and v12's
  three view-state columns, which travel together as one `UNDO_V12` constant so they cannot drift
  apart fixture by fixture — while v11's `CREATE TABLE IF NOT EXISTS` tables need no line in
  `v9_database` at all.
  **The per-rung fixture counts that used to be written out here are gone on purpose.** They read
  "all six below it" and "the five below that" against a fixture set that has grown twice since,
  and a count is a fact about a *tree*: `grep -c "{UNDO_V21}" src-tauri/src/schema.rs` is the
  census of how many fixtures the newest rung reaches, and it answers for the tree you are
  actually in. **v21 is a rebuild rather than an `ADD COLUMN`, and it still needs a line in every
  fixture**: `UNDO_V21` drops `deck_tags` and recreates the per-deck shape v8 built, because
  `ALTER TABLE … DROP COLUMN` refuses a column an index names and the shape changed both ways.
  **v22 is the first rung with no `UNDO_V22` at all, and that is a fact about the rung rather
  than an omission**: it writes no table, no column and no index — it repairs the contents of
  `oracle_tags.slug_norm` — so a v21 database and a v22 one are the same schema and a
  `PRAGMA user_version = 21` is the honest whole of the rewind. `v21_database` is built that way,
  and it is deliberately **not** on
  `every_version_ends_with_the_same_schema_as_a_fresh_install`'s list: that test asks whether
  every route arrives at one _schema_, and this route cannot answer anything else. What it seeds
  instead is the rung's real input — a blank `slug_norm` — which is the second half of
  `the_head_minus_one_fixture_really_sits_one_step_below_head` now that there is no column for it
  to find missing. **One named `UNDO_V…` constant per rung that writes shape** is the shape that
  keeps this
  cheap: v13 and v14 have each been renumbered since they were written, and the rename was the
  whole of what it cost. (`v10_database` drops them for a different reason: a fixture claiming to
  be a v10 must not already hold what the v11 step is being tested for creating.) Rewinding
  _too far_ fails the same way from the other direction: a head database rewound two versions
  re-runs v8's deck rebuild over v8-shaped tables and dies on a duplicate column — a failure no
  real upgrade can produce.
- v5 added the four deck tables (`decks`, `deck_cards`, `deck_allocations`
  and the seeded `format_specs`) and two `cards` columns, `power`/`toughness` — CR 903.3
  (2026) makes a commander out of a Vehicle or Spacecraft _with a P/T box_, and that is
  unanswerable without them. Its backfill reads `raw` through `schema::json_raw` exactly as
  v3's `artist` did, so it could only recover the **1 510 of 116 590** rows that keep a
  `card_faces` array; everything else fills on the next sync's swap. Until then **both
  columns NULL means unknown, never "no P/T box"**, and `deck::get_deck` repairs the rows
  that ask (`fill_unknown_power_toughness`, gunzipped in Rust, gated on a type line that
  could have one).
