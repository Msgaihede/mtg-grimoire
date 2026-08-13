# Search filter faceting

Moved out of the root `CLAUDE.md` verbatim, so nothing measured was lost. Every figure keeps the date and the build it was taken on.

The filter bar greys the options this search cannot reach. **The rule is one sentence: an
option greys when turning it on would not change the result set.** A _selected_ option is
never greyed — that is the way out of a dead end — and every failure fails **open**:
not-greyed means "we don't know", greyed means "this is empty", and only one of those is safe
to guess.

- **`CardIndex` is an in-memory index over the corpus, in the shape a search engine uses**,
  and it exists because faceting needs a count per option per dimension on every keystroke.
  The three SQL shapes were measured 2026-08-11 (see the build note under `legal_mask`): a
  four-dimension pass costs **2 238 ms** against `cards` as it stands, 62 ms with a covering
  index and the mask, 106–167 ms over a rowid-aligned shadow table. **The in-memory column of
  that comparison is a projection** — the design doc's §3.2 says 0.31 ms and a 57 ms worst
  case from a _JS harness_ over a structure that did not exist yet, and its own header calls
  that "a conservative bound on Rust". It was not one: the shipped `facets::compute` measures
  **1.8 ms** unfiltered (release, synthetic corpus, best of five), 5.8× the projection and
  still two orders inside the 100 ms budget. Quote `facets::compute` for what this costs;
  quote §3.2 only for what the design was decided on. **Low cardinality gets a bitset, high cardinality an
  ordinal array**: giving each of the 986 **paper** set codes its own bitset was the first
  design and was wrong by 18× on memory and 35× on speed (14.3 MB / 11 ms against
  0.78 MB / 0.12 ms). **986 and 1 047 are both right and mean different things** — 986 paper
  sets against 1 047 codes over every printing, because `set_ord` covers the whole corpus and
  a digital-only set still needs an ordinal (`index/mod.rs`). The picker's counts use 1 047.
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
  launch answers not-ready for about that long. On this machine the webview does not reach
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
  held for the whole sync.
- **Greying on the real corpus, measured in the shipped window 2026-08-11.** A `Lightning
Bolt` search greys mana values 4, 6, 7 and 8+ (`title` "Mana value 4 — nothing in this
  search", opacity 0.45); a `standard` format filter greys **26 of the 50 set rows on screen**
  out of 384–592 of the 1 047 codes the picker knows. (1 047 against the 986 quoted in
  `index/mod.rs`: that one is the **paper** corpus the index is built over, this one is every
  code `list_sets` returns.) A facet pass costs **4.4–47.6 ms** end to end through `invoke` on
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
