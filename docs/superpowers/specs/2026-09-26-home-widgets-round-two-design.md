# Home widgets, round two

Four new kinds for the home page's Add-widget catalogue — **Deck completion**, **To review**,
**Wishlist savings** and **Coming soon** — chosen on 2026-09-26 from a longer list of proposals
drawn on the Claude Design canvas
[Dashboard widget proposals](https://claude.ai/artifact/KD8KLMt59PTYHdkPbCZWKU). The canvas holds
one artboard per kind at its default footprint and is the picture this spec describes; where the
two disagree, this file wins.

Every fact below was read off the tree at `126d80cf` on 2026-09-26 unless it says otherwise. The
reference for everything already built is [home-page.md](../../reference/home-page.md).

**Considered and dropped the same day, so nobody proposes them again without a reason:** Commander
brackets, a `For trade` figure on Summary, Combos in your binder, What your cards do (oracle-tag
counts), Value history, From your binder, Sample hand. Value history was chosen and then scrapped;
its finding is worth keeping — `price_snapshots` stores prices and no quantities, so the only line
it can draw is *today's cards at each day's price*.

---

## 1. What is decided

| Decision | Answer | Why |
| --- | --- | --- |
| Where the kinds go | The catalogue only. `DEFAULT_LAYOUT` does not move, in any of its three copies. | home-page.md §3: the catalogue and the first-launch layout are two lists, and the default fills an 8×7 rectangle a new kind would break. |
| How they are built | Four independent kinds, each a registry row, a body and at most one new read. | The eleven existing kinds' shape; it fans out cleanly. Rejected: computing in TS from existing reads (one `deck_get` per deck per render, gaps on web) and one combined "digest" read (couples four widgets, breaks the key-root rule). |
| What Deck completion calls owned | **Exactly what the deck editor calls owned.** | Chosen by the reader. A widget saying "4 missing" about a deck that opens saying "6 missing" is a bug report. |
| Where To review's flagged rows go | **One row per place**, each opening that place. | Chosen by the reader over a single row into Settings. |
| Both targets | Every kind works in the browser build or says in words what it cannot do there. | `src/CLAUDE.md`'s rule for every surface. |

---

## 2. What the four share

### 2.1 Registry rows

`WidgetKind` gains four members and `WIDGET_META` four rows (`src/features/home/widgets.ts`).
Footprints are the canvas's:

| `kind` | label | `def` | `min` | `max` | picks | toggles | `chip` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deckCompletion` | Deck completion | 3×3 | 2×2 | 4×6 | `scope` (Most recent · Pinned), `order` (Nearest done · Cheapest to finish · Name) | `complete` "Complete decks", `dflt: false` | `order` |
| `toReview` | To review | 2×3 | 2×2 | 4×4 | — | `removed` "Recently removed" | — |
| `wishlistSavings` | Wishlist savings | 3×3 | 2×2 | 4×6 | — | — | — |
| `comingSoon` | Coming soon | 4×2 | 2×2 | 8×4 | `window` (30 days · 90 days · A year), `dflt: 90` | — | `window` |

A `deckCompletion` widget configured `Pinned` stores its decks as `deckIds`, and draws the same
checklist `DecksWidget` draws through `extraSettings` — reused, not copied.

`isWidgetKind` is a renderer's question and never a parser's (home-page.md §1): an older build
keeps these four as unknown-widget placeholders and a round trip loses nothing. Rust stores `kind`
untouched and needs no change for the vocabulary.

### 2.2 Three one-shot hand-offs

Three presses land on a page in a state it does not open in by itself. Each is a field on
`AppState` built exactly as `pendingFolder` is (`src/lib/store.ts:801`, rationale `:776-808`):

| Field | Written by | Consumed by | Does |
| --- | --- | --- | --- |
| `pendingReviewFilter: { scope: "collection" \| "wishlist" } \| null` | To review | `CollectionPage`, `WishlistPage` | turns that page's needs-review filter on (`useCollection`'s `setNeedsReview(true)`, `useWishlist`'s `setNeedsReview(true)`) |
| `pendingSettingsGroup: string \| null` | To review | `SettingsPage` | selects that rail group (`useState<GroupId>("updates")` at `SettingsPage.tsx:121` today); a word the page has no group for is dropped, so the store needs no import from `features/settings` |
| `pendingOptimize: boolean` | Wishlist savings | `WishlistPage` | opens `OptimizeWishlistDialog` over the **whole** wishlist |

The three rules `pendingFolder` already pays for apply to each, and each gets a `store.test.ts`
case in both write orders:

* **It sits inside `setActiveView`'s clear block**, so a hand-off lives for exactly one view change.
* **`setActiveView` first, the hand-off second**, at every call site — the inverse type-checks and
  leaves the store holding nothing.
* **The page reads it in a render-phase adjustment, never a mount effect**, and clears it — a
  `setState` in an effect body is the lint failure that dies only at `verify`.

**`pendingOptimize` does not touch the reader's flatten setting.** `wishlistFlattened` is a
persisted store field (`useWishlist.ts:192`) and the dialog today plans the page's own
`wishlist.filters` (`WishlistPage.tsx:402`). The hand-off opens the dialog with a scope override —
the whole list, flattened, no filters — so the dialog plans what the widget counted, and closing it
leaves the page as the reader left it.

### 2.3 Query keys

Every key sits under a root the data's writes already invalidate (home-page.md §3, `keys.ts`). Two
need more than one root, and use `ActivityWidget`'s bridge — a cache subscription that turns an
`invalidate` under another root into an invalidation of this key, plus a marker query under that
root so the signal exists at all:

| Key | Root | Also bridged from |
| --- | --- | --- |
| `["decks","completion",marketplace]` | `decks` | `collection` — owned copies are collection rows |
| `["decks","upcoming",days]` | `decks` | — (a finished sync invalidates `decks`: `SYNC_INVALIDATED` in `src/lib/useSyncInvalidation.ts`) |
| `["decks","reviewCount"]` | `decks` | — |
| `["wishlist","reviewCount"]` | `wishlist` | — |
| `["wishlist","optimize",WHOLE_LIST_QUERY]` | `wishlist` | — |
| `["scanner","trayCount"]` | `scanner` | — |

**The scanner tray's own key, `["scanner","tray"]`, is not shared.** That cache entry *is* the tray
in the window that owns the scanner, written with `setQueryData` (`useTray.ts:10, 121`), and
card-scanner.md says the stored copy can lag it by the 400ms debounce. The widget reads
`scanner_tray` under its own key and never writes.

Collection's `needsReview` and the `Recently removed` count reuse the keys their existing reads
already have.

**Clearing a flagged row refreshes the counts.** `ReviewPanel`'s clear (`sync_review_clear`)
invalidates only its own key today; it gains an invalidation of the root the cleared row's table
belongs to, so To review drops the row without waiting for a restart.

---

## 3. Deck completion

### 3.1 The read: `deck_completion(marketplace)`

In a new module `deck_completion.rs` (with `deck_review_count`, §4.1), its wanted copies and prices
read in one statement built on `deck_values`' join (`deck.rs:6469-6504`) — filters in the `ON`, so
a deck with no matching cards still answers a row — and each deck's pool read through `deck.rs`'s
own `owned_by_printing` / `available_by_printing`, made `pub(crate)`: 2 + N statements, because a
single statement would need a second copy of the `ForDeck` scope that `collection_source` exists to
keep in one place. One row per deck:

```rust
pub struct DeckCompletion {
    pub deck_id: i64,
    pub list: String,        // "live" | "theory" — which list was measured
    pub wanted: i64,         // copies the measured list asks for, active piles only
    pub owned: i64,          // of those, copies the pool covers
    pub missing: i64,        // wanted − owned
    pub missing_cost: Option<f64>, // priced missing copies at `marketplace`; None only when nothing
                                   // on the measured list is priced (DeckStats.tsx:509's rule)
    pub unpriced_missing: i64,
}
```

**What it counts is the deck editor's rule, character for character** (decks-storage.md
`:410-416`, `:456-459`):

* **A deck without a theory plan measures its live list against its own group.** The pool is
  `sum(quantity)` over `collection_entries` in the `collection_folders` row of kind `deck` for that
  deck (`deck.rs:5249-5272`, `owned_by_printing`), keyed by `(card_id, finish)`, a `NULL` deck-row
  finish matching `'nonfoil'` (`deck.rs:5379-5384`).
* **A deck with `theory_enabled` measures its theory list against the pool available to it** —
  the collection root, its own group and `Recently removed`; not other decks' groups, not locked
  folders (`Availability::ForDeck`, `deck.rs:5309`). That is the Theory tab's "N of M missing"
  (decks-storage.md `:434-441`).
* **Every active pile counts, sideboard and companion included.** This is the shortfall walk
  (`deck.rs:5480-5487`) and `DeckStats`' `missing`/`missingPrice` (`DeckStats.tsx:455-481`), and
  deliberately **not** `deck_values`/`card_count`'s narrower main + commander + maybe. The widget
  matches the number the editor shows; the two counts disagreeing inside the editor is an existing
  fact this spec does not change.
* **Ownership is exact printing and exact finish.** Condition and language are ignored, as in the
  editor. There is no "any printing" switch.
* **Totals per `(card_id, finish)` equal the editor's ordered walk.** `attribute_owned` hands each
  row `min(remaining, quantity)` from a shared pool; summed over a key that is `min(Σ wanted, pool)`,
  so the read aggregates in SQL rather than calling `get_deck` per deck. Price depends only on
  card and finish, so `missing_cost` sums in SQL too, through `sorting::deck_card_price_expr`.
* **Tokens never count** — they live in `deck_tokens`. **Virtual decks answer no row**: they hold
  nothing by definition, and 0% of every deck is not a finding.

**The fence is a Rust test that asks both questions of one fixture**: for every deck in a fixture
covering a live deck, a theory deck, a foil and a `NULL`-finish row, an inactive pile, a sideboard,
a copy in `Recently removed`, a copy in another deck's group, a locked folder and an unpriced
printing, `deck_completion`'s `missing` and `missing_cost` equal what `get_deck` + the editor's
arithmetic answer. A drift between the two is then a red build rather than a widget that disagrees
with a deck.

Routed on both targets (`desktop.rs` handler list, `web/route.rs` `COMMANDS` + match arm + routed
test + the `COMMANDS.len()` literal).

### 3.2 The body

* **Complete means `missing === 0`, never a cost of zero** — a deck whose only missing copies are
  unpriced also answers `Some(0.0)`, the editor's own rule.
* **Rows** — `WidgetRow` with a `track`: the deck's name, caption `96 of 100 · 4 missing`, value
  the missing cost through `formatPrice`, an em dash when `missing_cost` is `None`. A hint names the
  unpriced count when it is above zero. A press opens the deck: `setActiveView("decks")`, then
  `setOpenDeckId(id)` — `DecksWidget.tsx:273-276`'s order, because `setActiveView` clears the open
  deck.
* **Which decks** — `Most recent` is `deck_list`'s order with archived and virtual decks taken out,
  a filter and never a sort (`DecksWidget`'s rule); `Pinned` is the reader's `deckIds` in the order
  they chose.
* **Order** is a display decision and lives in TS: `Nearest done` (owned ÷ wanted, descending, ties
  by name), `Cheapest to finish` (a `None` cost last), `Name` through `sortOptions`.
* **Complete decks** (off by default): a deck with `missing = 0` leaves the list and is counted in
  the footer instead.
* **Footer**: `2 decks complete · $221.70 to finish the rest` — the rest being the decks in scope
  with something missing, not only the rows that fit.
* **Empty states, three sentences**: no decks in scope; every deck complete (and the switch off);
  `Pinned` with nothing picked, pointing at the settings.

---

## 4. To review

### 4.1 The rows

Drawn only when the count is above zero, always in this order, each a `WidgetRow` with a glyph:

| Row | Count | Press | Browser build |
| --- | --- | --- | --- |
| **Scanned cards** — caption `3 need a printing chosen`, or `Ready to add` when none do | `scanner_tray` length; unresolved = rows with non-empty `choices` (`tray.ts:228-231`) | `setActiveView("scanner")` | hidden — there is no scanner there (`ScannerPage.tsx:100`) |
| **Binder entries** — `Flagged for review` | `collection_summary.needsReview` (rows, not copies; `collection.rs:2334`) | Collection, `pendingReviewFilter: collection` | works |
| **Wishes** — `Flagged for review` | `wishlist_list({ needsReview: true, flatten: true, limit: 1, offset: 0 }).total` | Wishlist, `pendingReviewFilter: wishlist` | works |
| **Deck cards** — `Flagged for review` | new `deck_review_count()`: `count(*)` of `deck_cards` with `needs_review IS NOT NULL` | Settings, `pendingSettingsGroup: "sync"` — the group that holds Needs review | drawn **without a press**: `sync_review_list` is not routed on the web target, so the panel has nothing to show |
| **Recently removed** — `N copies` | the `removed` folder's row in `collection_folder_summary` (an empty folder answers no row, so the folder is found in `collection_folder_list` and looked up) | `setActiveView("collection")`, then `setPendingFolder({ scope, id })` | works |

Rows count **rows** where the table counts rows (flagged entries) and **copies** where the reader
thinks in copies (the removed folder), and each caption says which.

`deck_review_count` is its own read rather than `sync_relay_status.reviewCount` because that
command sums six tables into one number, is desktop-only and takes the write lock
(`sync_engine/commands.rs:35-46, 106-119`). Routed on both targets.

The `Recently removed` switch (on by default) exists because that folder is a holding area rather
than a problem, and a reader who uses it as an archive should be able to take the row away.

**Empty state**: `Nothing waiting for you.`

---

## 5. Wishlist savings

### 5.1 The read

No new command. `wishlist_optimize_plan` (`wishlist_optimize.rs:429-437`) already answers, per
pinned wish, both printings with their prices, `savedPerCopy` and `saved`
(`WishOptimizeMove`, `ipc.ts:1918-1942`). The widget asks it about the whole list —
`WHOLE_LIST_QUERY`, `flatten: true` and no filters, `marketplace` from `useMarketplace()`.

### 5.2 The body

* **Figure**: `Could save` — Σ `saved` over the moves whose `saved` is not `null` — gold, with the
  note `on N wishes`.
* **Rows**, biggest `saved` first: the wish's name, caption `Pinned $40.00 · cheapest $21.60`
  (`from.price` and `to.price`, each through `formatPrice`), value `saved`.
* **Footer**: `4 more wishes save $11.45` for the moves that did not fit. A move whose `from.price`
  is `null` has no saving to add, and is counted in its own line — `2 more have no current price`
  — never summed as zero.
* **A press — a row or the figure** — writes `setActiveView("wishlist")` then
  `pendingOptimize: true`, and the page opens the dialog over the whole list (§2.2).
* **Empty states**: no wish is pinned to a printing (`considered` is zero); every pinned wish is
  already at its cheapest.

**What it inherits from the plan and does not paper over**: wishes in managed (theory-deck) folders
and digital printings are skipped (`wishlist_optimize.rs:201-204, 270`), and the cheaper printing
may be in another language — the plan has no language filter (`:254-258`). The widget says what
the dialog will offer; a language rule, if one is wanted, belongs to the plan and both surfaces.

---

## 6. Coming soon

### 6.1 The read: `upcoming_sets(days)`

**Over `cards`, not `sets`**, because the browser build never fills `sets` (`insert_sets` is
`#[cfg(not(target_family = "wasm"))]`, `sync.rs:587`) while every card row carries its own
`set_code`, `set_name` and `released_at` (`schema.rs:4466-4471`). Answers one row per set:

```rust
pub struct UpcomingSet {
    pub code: String,
    pub name: String,
    pub released_at: String, // the set's earliest card date, YYYY-MM-DD
    pub previewed: i64,      // count(DISTINCT collector_number)
    pub in_decks: i64,       // distinct oracle ids also in the reader's decks
}
```

* **Which cards**: `is_paper = 1`; `released_at > date('now')` and
  `<= date('now', '+N days')` with `N` clamped to `1..=365`; `search.rs`' `NON_CARD_LAYOUTS`
  (tokens, emblems, art series, front cards) left out — shared, not copied. "Today" is SQLite's UTC
  date, as in `new_printings.rs:278-282` and `price_history.rs`, read once and returned as `today`.
* **Which sets, where `sets` has rows**: a `LEFT JOIN sets` drops `set_type` `token`, `promo`,
  `memorabilia` and `minigame`. Where it has none — the browser build — the layout filter is the
  whole rule.
* **`in_decks`** uses `new_printings`' defaults: decks that are not virtual, live and theory rows,
  basic lands left out (`BASIC_LAND_LIKE`).
* **Not index-assisted**: no index on `cards` leads with `released_at`, so the window is a scan of
  `cards`. The live pass times it on the real corpus; an index is a follow-up only if that number
  says so.

Routed on both targets.

### 6.2 The body

* **Figures**: `Previewed so far` (Σ `previewed`, note `cards`) and `Reprints of your deck cards`
  (Σ `in_decks`). Counts, so body ink.
* **Rows** in `fit.listColumns` columns, soonest first: the set's name, caption
  `TRK · in 12 days · 79 seen · 3 in your decks` (the last clause only when `in_decks > 0`). Days
  are counted from the UTC date the read used, formatted with `timeZone: "UTC"` like
  `NewPrintingsWidget`.
* **A press** calls `showSetInSearch(code)` (`store.ts:825`), which sets the format picker to
  `Any card` so legality does not hide an unreleased card (`useCardSearch.ts:1635-1647`).
* **Empty state**: `Nothing announced for the next 90 days.` — the window's own words.

---

## 7. Testing

* **Rust**: `deck_completion` against `get_deck` (§3.1); `upcoming_sets` at both window edges,
  each excluded layout, `set_type` exclusion with and without `sets` rows, `in_decks` with a basic
  and a virtual deck; `deck_review_count` over a flagged and an unflagged row. Each routed command
  gets its `route.rs` test.
* **The mirror**: each new struct on `ipc.test.ts`'s struct tables and each command in its
  `declares` cases — the only fence between `ipc.ts` and the crate (`src/CLAUDE.md`).
* **TS**: the pure functions — Deck completion's order and footer, Wishlist savings' sum and
  split, To review's row selection, Coming soon's day arithmetic — and each widget body, including
  every empty state. The three hand-offs in `store.test.ts`, both write orders, and the consuming
  page in its own test.
* **Storybook**: a handler in `.storybook/fake/db.ts` for each new command (+ `db.test.ts`), seeds
  that make every row of To review appear, and a story per widget for its full face, each empty
  state and the browser build's face.
* **Live**: the shipped window over CDP, against a **copy of the real debug database** (a fresh
  sync has cards and no collection, and every widget would draw its empty state): each kind added
  from the catalogue, each press landing where §3–§6 say, and a Needs review clear dropping To
  review's count.

## 8. Documentation

`home-page.md` gains a section per kind and one for the three hand-offs, and §3's table gains four
rows. **No count of kinds is written down** — the note at the head of §3 exists because that count
has been edited wrong before, and `WIDGET_META` answers it. `keys.ts`' doc comments carry the bridge
reasoning for the two bridged keys.

## 9. Delivery

One branch and one PR, in three waves so no two agents edit one file:

1. **Foundation**, two lanes in parallel — *Rust*: the three reads, their registration on both
   targets and their tests; *shared TS*: `widgets.ts` rows, the three hand-offs and their consumers,
   `keys.ts`, the `ipc.ts` mirror and `ipc.test.ts`, the fake's handlers, `ReviewPanel`'s
   invalidation.
2. **Four widget bodies in parallel**, each in its own files (`*Widget.tsx`, test, stories) plus
   one arm each in `HomePage.tsx`'s body switch — that file is the one shared edit and is merged by
   the dispatcher, not the lanes.
3. **Docs, one `npm run verify`, the live pass**, then `shipping-a-branch`.
