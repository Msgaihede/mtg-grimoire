# Search filter faceting

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

The filter bar greys the options this search cannot reach. **The rule is one sentence: an
option greys when turning it on would not change the result set.** A _selected_ option is
never greyed — that is the way out of a dead end — and every failure fails **open**:
not-greyed means "we don't know", greyed means "this is empty", and only one of those is safe
to guess.

**Greying decides the order as well as the paint.** A greyed option sinks below every
pickable one, and each half is alphabetical by the words on screen — `sortOptions` in
`src/lib/options.ts`, which every option list in the app is drawn through. It sinks rather
than disappearing for the reason the picker greys rather than filters in the first place:
dropping a row would make the list jump under the cursor on every keystroke, and the count
behind it ("nothing in this search") is an answer worth showing. Two properties make this
safe rather than jumpy, and both are the backend's doing — `facets::compute` skips the
dimension it is counting, so **picking a format does not reorder the format list and picking
a set does not reorder the set list**. A control never re-sorts under the press that is
using it.

- **`CardIndex` is an in-memory index over the corpus, in the shape a search engine uses**,
  and it exists because faceting needs a count per option per dimension on every keystroke.
  The three SQL shapes were measured 2026-08-11 (see the build note under `legal_mask`): a
  four-dimension pass costs **2 238 ms** against `cards` as it stands, 62 ms with a covering
  index and the mask, 106–167 ms over a rowid-aligned shadow table. **The in-memory column of
  that comparison is a projection** — the design doc's §3.2 says 0.31 ms and a 57 ms worst
  case from a _JS harness_ over a structure that did not exist yet, and its own header calls
  that "a conservative bound on Rust". It was not one: the shipped `facets::compute` measures
  **1.8 ms** unfiltered (release, synthetic corpus, best of five), 5.8× the projection and
  still two orders inside the 100 ms budget. **That figure was taken before the `mana_x`
  overlay**, which adds one `and_count` over the whole corpus to every pass; nobody has re-timed
  it, so read it as a floor. Quote `facets::compute` for what this costs;
  quote §3.2 only for what the design was decided on. **Low cardinality gets a bitset, high cardinality an
  ordinal array**: giving each of the 986 **paper** set codes its own bitset was the first
  design and was wrong by 18× on memory and 35× on speed (14.3 MB / 11 ms against
  0.78 MB / 0.12 ms). **986 and 1 047 are both right and mean different things** — 986 paper
  sets against 1 047 codes over every printing, because `set_ord` covers the whole corpus and
  a digital-only set still needs an ordinal (`index/mod.rs`). The picker's counts use 1 047.
- **The mana row's tenth chip, `X`, is an _overlay_ and not a tenth value — and that one word
  decides its SQL, its bitset and its base.** Scryfall counts `{X}` as zero when it computes
  `cmc` (CR 202.3b), so `{X}{B}{B}{B}` is mana value **3** _and_ an X card. The chip therefore
  joins the **same OR group** as the numerals rather than standing beside it:
  `push_card_filters` pushes `{alias}.mana_cost LIKE ?` — bound to `filters::VARIABLE_COST_LIKE`,
  `"%{X}%"` — inside the one parenthesis that already holds `cmc IN (…)`. Picking `3` finds that
  card, picking `X` finds it, picking both finds it **once**, from one row and one alternative.
  Pushed as a second `AND` term it would have meant "3 _and_ variable", which is an intersection
  nobody asked for and which is empty over most of the corpus. Three things follow, and none of
  them is a matter of taste:
  - **`CardIndex.mana_x` is a field beside the buckets, never an eleventh bucket.**
    `CardIndex::mana` is a **partition** — every printing in exactly one slot — which is what
    lets a bucket be a single `and_count` and what makes `MANA_BUCKETS` a closed list. X is an
    overlay: `{X}{B}{B}{B}` is `mana[3]` **and** `mana_x`. Widening the array to make room would
    put one card in two slots of a partition and quietly double every total counted over it.
  - **It shares `Skip::Mana`, so its count is taken over the same base the nine numerals are.**
    One OR group is one dimension, so the base that drops "the mana question" drops the whole of
    it — numerals and X together. Pressing X therefore does not grey the value chips and pressing
    a value chip does not grey X: the same rule the format and set lists get at the top of this
    page, that a control never moves under the press that is using it. A base that dropped the
    numerals and kept the X would count every numeral against a search still narrowed to the X
    cards.
  - **`FacetResponse.mana_x` is a scalar beside `manaValues`, not an `"x"` key inside it.** That
    map is a partition too — its values sum to the result set — and every other key parses as a
    number. A key that only looks like the others is what some later `Number(key)` turns into
    `NaN`; and one that double-counted every card already in `"3"` would make the sum a lie the
    moment anything read it as one. **The two numbers must never be added.**
  The facet request carries `manaX` and has it in its key (`useCardSearch`), like every other
  filter that decides which printings exist — so the counts describe the search the results list
  is showing, and a search for "3, and also X" cannot be answered out of the cached pages of a
  plain "3".
- **`{X}` only, never `{Y}` or `{Z}`.** Both exist; a handful of un-cards print them, and
  `validation/engine.ts`'s `symbolValue` scores all three as 0 — correctly, because it is
  answering _what is this cost worth_. A chip and a deck heading answer _what is this pile
  called_, and there the three are not interchangeable: a `{Y}` card filed under a heading that
  says X is a wrong label rather than a loose one. The rule is spelled once per side of the
  boundary and both spellings say so — `filters::VARIABLE_COST_LIKE` for the SQL and the bitset
  it must agree with, `lib/mana.ts`'s `hasVariableCost` for TS and the Storybook fake, which
  imports it rather than re-spelling the test.
- **Two dimensions are in every base and are not facets: `paper` and `playable`.** Neither is
  offered as a control on the row, so neither excludes its own filter — they narrow the base a
  count is taken over, including its own dimension's. **Their defaults are opposites**, which is
  the whole of what a reader has to keep straight: `paperOnly` is omitted-means-**true** (every
  caller wants it), while `playableOnly` is omitted-means-**false** and is sent explicitly by the
  search view alone (`useCardSearch`), because a collection and a wishlist list what the user owns
  and wants and an art card in a binder is still in the binder. `playable` is
  `cards.legal_mask != 0` — legal or restricted in at least one of the 23 keys — set per row at
  build time from the stored integer rather than folded out of `CardIndex::formats`, so it stays
  right for a bit this build has no name for. It cannot move a **format** count in either
  direction: every `formats[k]` is a subset of it.
- **What `playableOnly` hides, measured in the shipped window 2026-08-14** (`npm run tauri dev`,
  a **debug** build, live 116 703-printing corpus): of **107 346** paper printings, **9 032** are
  legal in no format — 8.4% — leaving **98 314** the search offers by default. Both figures are
  `facet_cards`' own exact `total`, which is printings and is not capped, read through the app's
  `ipc` module in the page. The shape of what it removes, on `lightning bolt`: **3 cards → 7**
  when the chip is pressed, and the four that arrive are three Mystery Booster playtest cards
  (`cmb2 67`, `mb2 596`, `unk rz34` — each printed with *TEST CARD — Not for constructed play*)
  and the `astx 76` art card. `Toralf's Disciple` (`mb2 261`) is in **both** answers: it is an
  ordinary reprint that happens to share a set with the playtest cards, which is the case a
  set-based or layout-based filter would have got wrong. The facets moved with it — mana chip 5
  was greyed on that search with the chip off and live with it on, which is the counts describing
  the same corpus the page does. Same numbers in the deck editor's docked panel, whose row is
  **371px** and gains no line from the chip (6 lines, 212px, with it and with it hidden); the
  search row at the 1024px floor is 4 lines and 124px either way.
  **All four geometry figures there are the nine-chip row's and have not been re-driven.** The X
  chip adds a 36px square and the group's 4px gap — 40px inside a wrapping flex row, which is
  exactly the kind of change that moves a line count without moving anything else. The
  printing counts and the greying claim above are facts about the corpus and are untouched by
  it; the pixels are not.
- **The rarity chips are a dimension of their own since the filter row was redesigned**, and they
  are the case the `Skip` mechanism was written for and had never been spent on. `CardIndex.rarity`
  is four bitsets — a bitset apiece rather than an ordinal array, because four is as low as
  cardinality goes here and the module's rule is that low cardinality gets a bitset (1 047 set
  codes were 14.3 MB and 35× slower before `set_ord` replaced them; four are ~58 KB). `Skip::Rarities`
  drops the whole rarity question from the base its own counts are taken over, so pressing `rare`
  does not grey `mythic` — the rule every other dimension here follows.
  **They are a vocabulary and not a partition, and nothing may sum them.** Scryfall prints
  `special` and `bonus` as well and the row offers neither, so a printing can be in none of the
  four and the counts do not add up to `total`. `CardIndex::RARITY_KEYS` is the list; the frontend
  mirrors it by hand in `FilterBar.tsx`'s `RARITIES`, in the same order, and that order is
  `sortOptions`' *second* kind of exemption — the order **is** the information, common through
  mythic, the way Near Mint through Damaged is on the collection's condition chips.
  **The normalisation is shared, and that is structural rather than tidy**: `filters::picked_rarities`
  is what both the SQL and `union_rarities` narrow by, for `picked_sets`' reason — a facet counted
  over a rarity the search dropped reports an option as live that the search cannot reach. It
  lower-cases, because `cards.rarity` holds Scryfall's own lower-case word and SQLite's `=` on
  text is case-sensitive.
- **The price band has no dimension and cannot cheaply have one — it is the newest thing on this
  page that fails open.** `priceMin`/`priceMax` narrow the wall in `run_search`, over
  `sorting::printing_price_expr` (the same expression the Price column shows), and
  `useCardSearch`'s `facetReq` deliberately does **not** send them. So a price-bounded search is
  faceted over the *unbounded* corpus and every count reads high.
  That is the direction this whole row is built to fail in — an over-read count offers an option
  that turns out empty, where an under-read one would hide cards nobody would think to report
  missing — and it is the same trade `rarity` (the single-valued field, which is the printings
  modal's `<select>`) and `oracleId` already make. **Closing it is not a sixth bitset.** A price
  is a function of the reader's *marketplace*: two of the four are priced out of `marketplace_prices`,
  a table the corpus scan does not read and which refreshes on its own schedule, so it would take
  a price array per marketplace and a lifecycle hook on the feed refresh, where every other
  dimension here is a column of `cards`.
  **An unpriced printing fails a bound end**, which is `NULL >= ?` being NULL rather than a
  decision: a shop that does not quote a printing has not offered it for nothing. On Card Kingdom
  and Mana Pool that is the whole corpus until the feed has been fetched.
  **Both halves were driven in the shipped window 2026-08-24** (debug build, the real
  116 700-printing corpus, TCGplayer). A `$200` floor took the wall from `5,000+ cards` to **486**
  and filled it with Power, Reserved List and serialised printings — so the filter works end to
  end — while the four rarity counts stayed at their *unfiltered* figures (27 886 / 23 816 /
  37 107 / 9 123), which is the fail-open above, visible. The rarity dimension itself is not
  fail-open and the same pass shows it: pressing Blue moved those four to 6 544 / 6 275 / 9 108 /
  1 912, and Blue + Mythic answered **542 cards**. **The four never summed to the total in either
  reading** — 97 932 against a playable paper corpus of ~98 314, and 23 839 against Blue's own
  23 989 — which is the `special`/`bonus` printings no chip offers, measured rather than argued.
- **Two filters have no dimension in the index and are resolved against the database instead:
  the FTS text and the tag terms.** `run_facets` turns each into a bitset over `cards.rowid`,
  intersects them, and hands `compute` the **one** narrowing set it takes — which is then in every
  base, including its own dimension's, because a facet describes the search the reader is looking
  at. Three rules run through that and each has a way of failing quietly:
  - **`None` means _no clause_, never _an empty set_.** All-punctuation text produces no text
    clause (`fts_query` answers `None`) and a cleared chip row produces no tag clause — an empty
    bitset in either slot would turn a search for `"!!!"` into zero results and grey every option
    over a page that is full. With both halves present they are intersected; with one, that one
    rides alone.
  - **Every bitset is sized from `ix.capacity`, never from a row count.** `BitSet::and` takes the
    **shorter** operand, so a set built to any other size silently truncates every base it narrows
    and sends back counts that are **low** — and low counts grey out options that would have
    worked, which hides cards and which nobody reports. The tag side is the reachable one: a tag
    reaches a few hundred illustrations against a 116 712-printing corpus, so a set sized from its
    own answer would be a handful of words long. `facets.rs`'s fixture seeds a printing at
    **rowid 5 000** for exactly this; four consecutive rowids all live in word 0 and cannot catch it.
  - **The tag slugs come from `filters::picked_tags`, the search's own normaliser**, called rather
    than re-derived — a facet counted over a slug list the search trimmed differently reports
    options as live that the search cannot reach. The **weight floor rides the art include arm and
    nothing else**, mirroring `push_card_filters` clause for clause: the exclude arm ignores it
    ("not a dog" means not a dog at all, including weakly) and the oracle closure has no `weight`
    column to read.
- **What a tag term costs, measured 2026-08-20** through `node:sqlite` against a copy of the dev
  database (116 712 printings, `oracle_tag_cards` at 423 080 rows), with v20's
  `idx_oracle_tag_cards_slug` created on the copy — that database is at `user_version` 19 and
  predates the art tables entirely. Best of five, and a **ceiling** rather than the Rust cost: the
  harness marshals every rowid into a JS object where `probe_docs` sets a bit. `triggered-ability`
  (47 599 printings) **25.0 ms**, `activated-ability` (39 502) 19.2 ms, `removal` (20 763)
  12.7 ms, `ramp` (9 522) 7.3 ms — so the widest tag in the corpus lands on the same 25 ms the FTS
  bitset costs at 100 129 matches, which is the floor for any design. The plan is
  `SEARCH t USING COVERING INDEX idx_oracle_tag_cards_slug (slug=?)` feeding
  `SEARCH c USING COVERING INDEX idx_cards_oracle (oracle_id=?)`, pinned by
  `the_facet_closure_lookup_probes_both_indexes_and_scans_neither`. **It is one statement per
  picked slug**, so three tags cost three of them, and nothing is cached.
- **A keystroke DOES reach those statements, and this file used to say it could not.** The claim
  was that the Tags page's only text box searches *tags*, so the facet key moves on a chip press
  and never on a keystroke. That is true of the rail's type-ahead and false of the page: it also
  renders `FilterBar`, whose `#card-search-text` is unconditional and feeds `debouncedText` into
  `facetReq.text`. Driven in the shipped window **2026-08-20** with the real 952,729-row art
  closure and `plane` (38,144 illustrations) picked, typing into the card box produced exactly one
  `facet_cards` carrying both `text` and `artTags`, at **47 ms** — debounced, so one call per
  pause rather than one per character. Measured over the same taxonomy, through the app, best of
  three, **debug build**: nothing picked 30 ms · text only 6 ms · `plane` 63 ms · `plane`+text
  46–56 ms · `plane`+text+floor 142–152 ms · `plane`+`humanoid`+text 65–82 ms · `dog` 5 ms. **Text
  does not add to a tag** (the FTS bitset narrows what `compute` then walks) and **the cost is per
  picked slug and scales with that slug's breadth**, which is why `dog` costs nothing and a second
  wide tag adds ~20 ms.
- **The floored facet probe, at real breadth**: `plane` 63 ms unfloored against **153–174 ms**
  floored — **2.4×**, the same shape as the synthetic 25.6 → 91.3 ms below and about the same
  ratio, so that estimate held up. Same run, same day, debug build. It is not a reason to widen
  `idx_art_tag_illustrations_slug`: see `index/facets.rs`, where `(slug, weight)` is measured at
  ten times *worse* than the status quo against the real closure.
- **Three statements read the tag closures, all three have a different sensitivity to the slug
  index, and one figure must never be quoted for another.** They are easy to conflate because
  they are all "a tag lookup", and the numbers differ by four orders of magnitude:
  - `tags::query`'s correlated `count(*)` — the tag search box's reach-per-tag — is the **hang**:
    **49 ms** with the index against **531 seconds** without, because a wide needle is 11 531
    candidate tags × a 951 499-row scan each. That figure is `TAG_INDEXES_SQL`'s, and it belongs
    to the type-ahead rather than to anything on the filter row.
  - `push_card_filters`' card filter **is no longer a correlated `EXISTS` on its include arm**,
    which is what this bullet used to describe. Since 2026-08-20 an include is
    `subject_id IN (SELECT … WHERE slug = ?)` — the closure is read once for the slug and `cards`
    is driven through `idx_cards_illustration` — and the collapsed count it feeds measured
    **315 ms → 8 ms** on `dog` and **725 ms → 614 ms** on `plane`, with the weight floor going
    from 1.7–3.6× to free. The *exclude* arm is still a correlated `NOT EXISTS`, deliberately, and
    `filters.rs` says why in the one place a reader would try to "simplify" it. Its cost without
    the slug index is still unmeasured and nothing should attach a number to it.
  - **The facet's set form is measured on both sides and degrades rather than hangs**: without the
    slug index it plans as one `SCAN t` for the whole statement rather than a scan per anything,
    and `removal` measured **57.1 ms** against 12.7 ms, same run, same day. A 4.5× regression,
    which is what `the_facet_closure_lookup_probes_both_indexes_and_scans_neither` guards.
- **The art weight floor costs the covering index — the one number here worth watching.**
  `weight` is not in `idx_art_tag_illustrations_slug`, so a floored lookup takes a second seek per
  closure row into the `WITHOUT ROWID` table. Measured the same day, same harness, over a
  **synthetic** art closure: 588 744 rows over the corpus's *real* `illustration_id` column
  (111 735 non-NULL, 50 536 distinct), because **no art taxonomy has been ingested anywhere yet** —
  so the join cardinality is the live one and the tag breadth is invented. The widest slug ran
  **25.6 ms** unfloored against **91.3 ms** floored (78.5 ms on a re-run), the plan dropping from
  `SEARCH t USING COVERING INDEX` to `SEARCH t USING INDEX`. **The fix is measured and
  deliberately not taken**: widening that index to `(slug, weight)` restores the covering plan and
  takes the floored query to **24.0 ms** while leaving the unfloored one at 23.2 ms, for a 0.7 s
  one-time build — but it is a schema change (`TAG_INDEXES_SQL` runs unconditionally with
  `IF NOT EXISTS`, so widening it needs a ladder rung to `DROP` the narrow one first) bought
  against a breadth nobody has demonstrated in the real taxonomy, where `dog` reaches 439
  illustrations. **That measurement has since been taken and the answer was no** — see the
  bullet above and `index/facets.rs`' `DO NOT WIDEN THAT INDEX TO (slug, weight)`: against the
  real 952,729-row closure that index measured *ten times worse* than the status quo, and the
  floor's cost was removed by changing the card filter's query shape instead, at no schema
  cost. Everything above this sentence is the synthetic closure it was written against.
- **It is derived, and it is rebuilt wholesale.** Nothing is patched in place except `owned`,
  the one dimension a user changes without a sync. `cards` is dropped and recreated by every
  sync, which renumbers every rowid, so a stale index does not go gently out of date — **it
  points at the wrong cards**. Hence: rebuilt after every staging swap, and every path
  **clears before it fills** rather than swapping at the end.
- **A stale index is worse than no index, which is what decides the whole lifecycle.**
  `facets::compute` counts an option it has never heard of as **zero**, so an index one sync
  behind greys out sets the search would happily return printings for. Cold is therefore a
  supported state and the only safe guess: `ready: false`, every map **empty** rather than
  zeroed, and `facetsOrUndefined` collapses that to `undefined` so all five controls stay
  live. Nothing here is fatal either — if the index cannot be built the app runs exactly as it
  did before the feature existed.
- **The X chip is the one count that cannot fail open on a raw cold response, and
  `facetsOrUndefined` is the entire guard.** Every other count on the row is read out of a map,
  and a cold response's maps are **empty**: the lookup misses, the miss is `undefined`,
  `undefined` means "we don't know", and the control stays live even if the response reaches it
  ungated. `manaX` is a scalar and has no empty to send — Rust answers `0`, and the fake's
  `indexCold` handler answers `0` beside its empty maps for the same reason — and **`0` is
  precisely what the greying rule reads as "nothing in this search"**. Nothing downstream can
  tell that zero from a counted one. So the `ready` check, which is belt-and-braces for the four
  maps, is load-bearing here: a caller reading `facets.manaX` rather than
  `facetsOrUndefined(facets)?.manaX` would grey the X chip through the whole of a cold index and
  the whole of a first-run sync, and nothing would say so. `owned` and `total` are scalars too
  and neither is a counter-example: `total` is only ever a denominator, and `colorDisabled`'s
  "an absent `after` fails open" arm fires before it is read; `owned` feeds a tooltip on the one
  chip that is **never** greyed. X is the only scalar on the response that decides paint, which
  is exactly why the guard has to hold for it.
- **The greying rule itself is `countDisabled(count, selected)`, and `optionDisabled` is a lookup
  in front of it.** Two arms over the one count a control was handed — a _selected_ option is
  never greyed, an _absent_ count fails open — and the lookup adds the third, that a key missing
  from a present answer is an absent count (`counts?.[key]` collapses both into one `undefined`).
  Split out **for the X chip**, whose count is a field rather than a key, and split out rather
  than copied for the reason a rule with two homes always is: a second pair of those lines
  written beside the map lookup is how one row ends up greying by two rules that agree until they
  don't.
- **The collection's filter bar remains deliberately not facet-aware, X included.** It wires no
  counts on any axis — no chip there greys, none carries a sentence — so its X chip is the
  search's chip minus the count. `ManaValueChips`' `onToggleX` **gates the render**: a caller
  that omits it gets exactly the nine chips the group drew before X existed, so there is no state
  in which the chip is drawn and dead. The count, where there is one, joins the **accessible
  name** and not only the `title` — `facetTitle` composes it onto the chip's own label, so X
  reads as `Cards with X in their mana cost — N printings` exactly as its neighbours read as
  `White — N printings`, and the visible `X` stays inside the spoken name (WCAG 2.5.3).
- **A failed build is recorded in `error_log`, because failing open is otherwise completely
  silent.** The UI's answer to a cold index is to leave every control live, which looks
  exactly like a warm index that greyed nothing — so nothing on screen distinguishes "the
  index is fine" from "the index has never built". Both call sites record through
  `sync::note_database` (`Source::Database`, `Kind::Io`, operations `index_build` and
  `index_owned_refresh`), keeping the `eprintln!` beside it for a dev
  console. It takes the **write** lock, which is only safe because both call sites hold
  nothing: `spawn_build` is on its own thread, and `collection_source::with_write_owned` releases
  its guard _before_ calling `invalidate_owned`. The "build superseded" message stays an
  `eprintln!` and is deliberately **not** recorded — it is an expected interleaving, not a
  failure, and whatever superseded it owes a rebuild of its own.
- **The warm-up is ~767 ms** (median of five, 762–783, release build, warm page cache), so a
  launch answers not-ready for about that long. **Measured when the build's scan read six
  columns**; the X overlay added `mana_cost` to it, making seven, and nobody has re-timed the
  build since — so that is a floor rather than this build's cost, and `index/mod.rs` says the
  same at the query. On this machine the webview does not reach
  first paint until ~2.6 s, so **the cold path is not reachable through the UI on a warm
  start** — which is why the Storybook fake carries an `indexCold` fault at all.
- **A not-ready answer corrects itself, and nothing else in the app would ever correct it.**
  `useCardFacets` carries `refetchInterval: (q) => q.state.data?.ready === false ? 500 : false`
  — polling only while cold, and switched off by the first ready answer. It is there because
  `sync.rs` calls `lifecycle::spawn_build` and `emit_done` on consecutive lines, and
  `spawn_build` runs its `clear` **synchronously on the caller's thread**, so `done` is
  emitted over a cold index _by construction_. `useSyncInvalidation` invalidates `["cards"]`,
  which prefix-matches the facet key, so the one refetch a finished sync produces lands inside
  the ~767 ms build and caches `ready: false`: a success (no retry), same filters (no new key),
  inside `staleTime` (not stale). **Found in the shipped window 2026-08-11** — after a sync the
  unfiltered row showed no counts while `facet_cards` called directly answered `ready: true`.
  Touching any filter healed it instantly, which is what bounds the damage to the unfiltered
  row. Gated on the _meaning_ rather than on one cause, so it also covers the launch build, the
  empty corpus, and a build that failed and will never announce anything.
  **Verified on a real first run, untouched**: chips plain through the whole opening sync, then
  captioned ("White — 30,223 printings") the moment the index published — and the query's
  `dataUpdateCount` stopped dead at 40 (≈40 × 500 ms over a ~20 s cold window) rather than
  climbing, which is the half of the claim that says it does not poll a healthy index forever.
- **An index over an _empty_ corpus answers `ready: false` too**, and that is the state a new
  user is in for the whole of the opening sync — **~20 s** _inferred_ on the release build this
  was driven on (2026-08-11: the index answered `ready: true` 21 s after launch, and a ready
  index needs an ingested, swapped corpus), against the ~93 s [data-and-sync.md](data-and-sync.md) quotes
  from a _debug_ run. Nobody has stopwatched a release sync end to end.
  Counted honestly every option is zero,
  the greying rule dims the entire row, and with no filter on there is no `Reset all` drawn to
  escape by. Verified in the shipped window 2026-08-11 against a cleared `data/`: **0 of 19
  chips greyed, 0 of 8 format options disabled, and no chip carrying a count in its name**,
  held for the whole sync. **Left at 19 rather than restated**: the row has carried a twentieth
  chip since X joined it and nobody has re-driven a first run against the wider row. What the
  measurement claims is _none greyed_, which a wider row does not change — but the X chip is the
  one to check first if it is ever re-driven, for the scalar reason above. The same note is on
  `SearchPage.stories.tsx`'s `Empty`, which is the story that pins this state.
- **The X chip, driven live 2026-08-14** (`npm run tauri dev`, a **debug** build, 1280×800,
  against a corpus of **116,703** cards synced 2026-08-13). The row drew **ten** chips, the
  tenth named `Cards with X in their mana cost — 2,009 printings` — so the count reaches the
  accessible name on the same rule as `Mana value 0 — 12,162 printings` beside it.
  - **The additive rule, shown on one card rather than argued from a total.** Text `fireball`
    alone answered **3 cards**; adding the X chip narrowed it to **1**; clearing X and pressing
    **Mana value 1** instead answered **1** as well. Fireball is `{X}{R}` — mana value 1,
    because X counts zero (CR 202.3b) — and it is found by *both* chips. That is the whole of
    what "additive" means here, and it is the half a total cannot show: pressing X **and** 3
    together read `5,000+ cards`, which is the result cap and proves nothing either way.
  - **The chip reaches the deck editor's search panel too**, unasked — `DeckSearchPanel` mounts
    the same `FilterBar`, so the tenth chip arrived there by construction rather than by a
    second wiring.
  - **Unmeasured, and named so it is not mistaken for measured**: nobody has re-driven a
    first-run sync against the ten-chip row, so the cold-response guard above is still argued
    from the code and from `facets.test.ts` rather than from the window.
- **Greying on the real corpus, measured in the shipped window 2026-08-11.** A `Lightning
Bolt` search greys mana values 4, 6, 7 and 8+ (`title` "Mana value 4 — nothing in this
  search", opacity 0.45) — **read that as four of the nine chips that existed that day**; the X
  chip is not in the count, was not on the row, and has not been driven on this search. A
  `standard` format filter greys **26 of the 50 set rows on screen**
  out of 384–592 of the 1 047 codes the picker knows. (1 047 against the 986 quoted in
  `index/mod.rs`: that one is the **paper** corpus the index is built over, this one is every
  code `list_sets` returns.) **The "50 set rows on screen" is the cap as it stood that day and
  not the cap now**: the picker's first page is 100, with a `Show 50 more` step
  (`MAX_OPTIONS`/`MORE_STEP` in `SetCombobox.tsx`), and greyed rows now sink to the bottom of
  the list — so a re-measure would count a different 26 in a different place. The 384–592 and
  the 1 047 are untouched by either change; they are facts about the corpus, not about the
  page. A facet pass costs **4.4–47.6 ms** end to end through `invoke` on
  a **debug** build (medians of five; worst is a colour dimension at 47.6 ms) and
  **4.7–6.0 ms** on a **release** one — so the design's 57 ms budget is cleared with the
  pessimistic figure. Name the build: the ~8× between those two lines is the whole reason
  this sentence carries both.
- **`aria-disabled`, never the `disabled` attribute** — a `disabled` button leaves the tab
  order, and a filter row that greys as the reader types would shrink and grow under a
  keyboard caret. Verified live: a greyed chip has `tabIndex 0`, no `disabled` attribute, is
  **reached by a real Tab** from its neighbour, and takes Enter and Space with **0**
  `aria-pressed` flips against 1 and 2 for the same two keys on a live chip. Count
  activations, never whether one happened: Space activates on keyup. The one place a real
  `disabled` is right is the format `<option>` — a native listbox option is not a tab stop
  there is anything to lose.
- **A chip greyed by the previous search swallows a press for ~300–330 ms after the box is
  cleared, and the defect is the swallowed press — not "greying while not knowing".**
  Measured live: pressing "Mana value 7" 5, 167 and 288 ms after clearing `Lightning Bolt`
  did nothing; at 336 ms and beyond it acted. The _trigger_ is `DEBOUNCE_MS` (300). **The app
  is not guessing during those 300 ms**: the search's query key and the facet request are
  both built from `debouncedText` (`useCardSearch.ts`) and both hold previous data, so the
  counts describe _exactly_ the search the results list is still showing — the caption still
  reads "7 cards" and the chip agrees with every row on screen. What it disagrees with is the
  **box**, which is already empty. So the harm is narrow and real: a press is silently dropped
  on a control the reader can see is dim beside a search box they can see they have cleared.
  It is shipped deliberately, and the fix, when it is wanted, is **inside faceting** rather
  than in the search box. Note what one line buys: failing open while `text !== debouncedText`
  closes the debounce window and **not** the in-flight one — `keepPreviousData` holds the
  previous _filter set's_ answer for the ~32 ms a facet call is in flight (a format change
  swaps the counts within **6 ms** when the new filter set is already in React Query's cache),
  which is the same disagreement one filter wide instead of one search wide. Only
  `!query.isPlaceholderData` closes both, at the cost of the flicker `keepPreviousData` exists
  to prevent. That is a design call between a chip that can be one answer stale and a row that
  blinks on every keystroke — not a debt someone forgot to pay.
