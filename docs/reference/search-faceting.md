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
  index is fine" from "the index has never built". `lifecycle::note_index_failure` is
  `sync.rs`'s `note_database` pattern (`Source::Database`, `Kind::Io`, operations
  `index_build` and `index_owned_refresh`) and it keeps the `eprintln!` beside it for a dev
  console. It takes the **write** lock, which is only safe because both call sites hold
  nothing: `spawn_build` is on its own thread, and `collection::with_write_owned` releases
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
