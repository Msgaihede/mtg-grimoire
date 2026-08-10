# Card Search Improvements — Design Spec

**Date:** 2026-08-11
**Status:** Approved
**Measured against:** the live synced corpus at `src-tauri/target/debug/data/mtg.db` on 2026-08-11 —
547 MB, **107,337 paper printings**, **37,553 distinct paper `oracle_id`s**. Every timing below is
the median of five runs after a warm-up, taken through `node:sqlite` against a *copy* of that
database so the user's own was never written to.

## 1. Overview

Three changes to the card search, plus one ranking fix that fell out of measuring them.

1. **Printings collapse into one row per card**, with an "All printings" toggle that defaults off.
2. **Foil printings are marked on the card art** — a holo sheen and a corner chip — through a card
   component extracted for the purpose, so every surface that draws a card gets it from one place.
3. **The foil price marker becomes a glyph** instead of the letter `F`.
4. **Non-cards are demoted in relevance ranking** — art series, tokens and emblems rank below real
   cards for the same query. Nothing is hidden and no filter is added.

### Explicitly not in scope

**Hiding art cards and other special cards behind a toggle.** Proposed, costed, and dropped on the
user's direction: the existing filters cover the need. §5 is what replaces it, and it is a ranking
term rather than a filter — every printing that is returned today is still returned.

## 2. The measurements that decided the design

The default browse is the state the page opens in, so its cost is the design constraint.

| query | today | collapsed |
|---|---|---|
| default browse, page 1 (50 rows), status subqueries included | 301 ms | **108 ms** |
| capped count | 15 ms | **31 ms** |
| **the page as the view opens it (page + count)** | **316 ms** | **139 ms** |
| page 100 (offset 4950 — the deepest the pager reaches) | 53 ms | **119 ms** |
| price sort | 345 ms | **95 ms** |
| text `dragon*`, relevance-ranked | ~2 ms | **25 ms** |
| text `bolt*`, relevance-ranked | ~2 ms | **2.1 ms** |
| Set / Rarity / Type header press, **no filter at all** | 313–325 ms | **600–620 ms** |

Collapsing therefore makes the state the page opens in **2.3× faster**, and the only thing it makes
slower is a header press on a completely unfiltered browse. With any text in the box every one of
those sorts is ~40 ms, because FTS narrows the set before the grouping runs.

### Three shapes were measured and two rejected

| shape | default browse |
|---|---|
| `row_number() OVER (PARTITION BY oracle_id …)` | **2,486 ms** |
| `GROUP BY` + join back on `oracle_id` and a composite key | 767 ms |
| `GROUP BY` + join back on the **primary key** (below) | **108 ms** |

The window function stays at 2,475 ms even with the new index available, so it is not a tuning
problem — it is the wrong shape. It sorts and partitions all 107 k rows before `LIMIT` can apply.

### 2.1 The group key is null-safe, and that costs 69 ms

`cards.oracle_id` is NULLABLE. A bare `GROUP BY c.oracle_id` puts **every** null-oracle printing in
one group — not a wrong row but a *merged* one, showing N unrelated cards under a single name with a
printing count and a price range spanning all of them, and nothing anywhere would flag it. The group
key is therefore `coalesce(c.oracle_id, c.id)`, which gives a null-oracle printing a group of its
own.

| group key | browse page | count | 3 fixture rows, 2 of them null-oracle |
|---|---|---|---|
| `c.oracle_id` | 38 ms | 0.8 ms | **2 groups — wrong** |
| `coalesce(c.oracle_id, c.id)` | **108 ms** | **31 ms** | 3 groups |
| `c.oracle_id, CASE WHEN c.oracle_id IS NULL THEN c.id END` | 93 ms | 34 ms | 3 groups |

The compound key is 15 ms cheaper than `coalesce` and yields a *nullable* group key that every
downstream join then has to handle; `coalesce` yields one non-null key and is what the design uses.

No live row is null — 0 of 116,590, reversible printings included — so this is 69 ms spent on a
population of zero. It is spent anyway because the failure mode is silent, and because the collapsed
browse is still 2.3× faster than today's with it.

**An expression index on `coalesce(oracle_id, id)` does not rescue the 69 ms**: measured, SQLite
scans it but will not treat it as *covering*, so the page went to **700 ms**. The plain index below
is what the group step reads.

**The status subqueries must key on `c.oracle_id` — the joined representative's own column — and
never on the group key.** Writing them against `coalesce(...)` cost the browse **1,514 ms** and the
rarity sort **12,729 ms**, because the expression is not indexable and every one of 37,553 groups
then re-scanned `cards`. Measured, and the single most expensive mistake available in this design.

## 3. Collapse — backend

### 3.1 The representative, and why the join is a primary-key lookup

The representative is the **newest printing** of the oracle card. The group step computes

```sql
substr(max(coalesce(c.released_at,'0000-00-00') || c.id), 11) AS rep
```

`released_at` is a fixed-width ISO date, so coalescing it to `'0000-00-00'` makes the concatenation
sort exactly as `released_at DESC, id DESC` — and because the date is always 10 characters,
**`substr(…, 11)` is the representative's `id`**. That is what turns the join back into
`JOIN cards c ON c.id = g.rep`, a primary-key lookup, and it is the difference between 767 ms and
108 ms. Verified against a per-group `ORDER BY released_at DESC, id DESC LIMIT 1`: **50 groups
checked, 0 mismatches.**

Ties on `released_at` are broken by the **greatest** `id`, where the uncollapsed browse's
`ORDER_NAME` breaks them by the least. Ids are UUIDs, so both are arbitrary; the pick is stated here
and pinned by a test rather than left to chance.

### 3.2 The index

One new entry in `schema::CARDS_INDEXES` — the hard rule is that the sync's `swap_staging` drops
`cards` with its indexes and replays only that list, so an index written anywhere else disappears at
the next sync:

```sql
CREATE INDEX IF NOT EXISTS idx_cards_collapse
    ON cards(oracle_id, is_paper, released_at, id, name, price_usd)
```

Every column the group step touches, so the scan is covering. **14 MB** on a 547 MB database and
**0.7 s** to build, against a sync that already takes 92–99 s.

A wider index covering `layout`, `rarity`, `set_code`, `collector_number` and `type_line` was built
and measured: 19 MB, and it made the name sort **slower** (38 → 61 ms) while leaving the three
expensive sorts unchanged (they cost row lookups, not index reads). Rejected.

Existing databases get the index through a schema **v7** step that re-runs `cards_indexes_sql()`.
Every statement in that list is `IF NOT EXISTS`, so the step is idempotent and the other three
indexes are untouched. Nothing here reads `raw`, so `schema::json_raw` has no part to play; nothing
here touches an FTS-indexed column or renumbers a rowid, so **no FTS rebuild is owed** — the same
reasoning as the v2 and v3 backfills, and it gets the same test.

### 3.3 Relevance under collapse: `bm25` cannot be aggregated

`min(bm25(cards_fts, 10.0, 1.0, 1.0))` fails with **"unable to use function bm25 in the requested
context"**. So does the same expression inside a plain subquery, and so does a normal CTE. Measured
2026-08-11; the four forms that were tried and their outcomes:

| form | result |
|---|---|
| `min(bm25(…))` directly in a `GROUP BY` | **fails** |
| `SELECT min(score) FROM (SELECT bm25(…) score …)` | **fails** |
| `WITH m AS (…) SELECT min(score) FROM m` | **fails** |
| `WITH m AS MATERIALIZED (…) SELECT min(score) FROM m` | **works** |

`MATERIALIZED` is therefore load-bearing and not a hint that can be dropped for tidiness. The
alternative — FTS5's `rank` column, which *does* aggregate — carries the table's default bm25
weights, and this app weights the name column 10× the type line and oracle text. Using `rank` would
silently throw that away, which is exactly the regression
`relevance_puts_the_card_that_is_named_for_the_query_first` exists to catch.

A collapsed group's relevance is the **best** score any of its printings scored (`min`, since bm25
returns smaller numbers for better matches).

Cost: `dragon*` 21 ms, `bolt*` 1.7 ms. A pathological one-letter prefix (`a*`, 60 k+ matches) is
598 ms — the 300 ms debounce means it is reached by pausing on a single letter, and it is recorded
here rather than optimised.

### 3.4 What a filter means when rows are grouped

**Filters narrow printings first, then the survivors are grouped.** So `×N printings` and the price
range describe *what matched*, never everything that exists: a search filtered to one set shows how
many printings **in that set**, priced across **those**. This keeps one SQL shape for every filter
combination, and it is the honest reading — the row summarises the answer, not the database.

`ownedQuantity` is the exception, and deliberately: it sums copies across **all** printings of the
oracle card, because "do I have this card" is the question a collapsed row asks. `wishlisted` is
true for a wish on any printing or on the oracle card. Both probe `c.oracle_id` on the joined
representative row, for the reason §2.1 measured at four figures; the 108 ms page carries them.

### 3.5 The sorts

| sort | answered by | unfiltered browse |
|---|---|---|
| name | the group step (`min(name)`) | 108 ms |
| price, low end asc / high end desc | the group step (`min`/`max(price_usd)`) | 95 ms |
| relevance (text searches) | the group step (`min(score)`) | 2–25 ms |
| set, rarity, type | the **representative's** own columns | 600–620 ms |

The first three are computed by the grouping itself, so `LIMIT 50` applies before the join and only
50 rows are ever fetched. The last three are properties of a row the group step has not resolved
yet, so all 37,553 groups are joined and sorted before the limit. That is the 600–620 ms, it happens
only on a completely unfiltered browse, and any text at all takes it to ~40 ms.

Sorting by an aggregate instead — "the best rarity this card was ever printed at" — was rejected:
CLAUDE.md's rule is that a header sorts by what its column shows, and the column shows the
representative's rarity.

### 3.6 Wire shape

`SearchRequest` gains `collapse: Option<bool>`. Absent means **false**, so every existing caller
sends exactly the payload it always did and behaves exactly as it always did; the search view states
its intent explicitly. `CardSummary` gains three fields:

| field | collapsed | uncollapsed |
|---|---|---|
| `printings: i64` | printings in the group | `1` |
| `priceLow: Option<f64>` | `min(price_usd)` over the group | `= priceUsd` |
| `priceHigh: Option<f64>` | `max(price_usd)` over the group | `= priceUsd` |

One shape for both modes, so no consumer needs to know which mode produced a row. The camelCase
mirror in `src/lib/ipc.ts` is hand-written and is covered by the existing whole-value JSON equality
test, which fails loudly if a field is added here and not there.

The capped count becomes `SELECT count(*) FROM (SELECT 1 … GROUP BY oracle_id LIMIT 5001)` — it
counts **cards**, not printings, which is what the caption beside a collapsed list must say.

## 4. Collapse — frontend

`useCardSearch` gains `allPrintings: boolean`, default `false`, in the query key.

**It is a view mode, not a filter.** Like the sort and unlike Owned, it stays out of
`activeFilterCount` and out of `resetAll`: clearing what you are looking at should not also change
whether you are looking at cards or at cardboard. The chip sits at the right of the filter bar with
the layout toggle, which is the other control answering "how am I looking at this".

**Table.** `×132 printings` under the name. The Price column renders `$0.75–$4,200` when the ends
differ and a single price when they do not, and sorts by the low end ascending, the high end
descending — which is what pressing a range column means in both directions.

**Grid.** The printing count is a corner mark at the **top-left**. The three corners are now spoken
for and each has one owner: bottom-left the owned/wishlist badge, top-right the foil chip, top-left
the printing count.

**The name a collapsed row shows is `min(name)` across the group, which is also its sort key.** 71
of the 37,553 groups span two names, all of them reversible cards — `Command Tower` beside
`Command Tower // Command Tower` — and `min` picks the canonical spelling in every one. Displaying
the representative's name instead would let a row sort under one name and read as another.

**The deck editor's docked panel inherits this**, because it is `useCardSearch` + `FilterBar` +
`CardGrid` and deliberately not a second search. A deck builder searching "Sol Ring" wants one row
rather than 132; a drag from a collapsed tile adds the representative printing, and the card pane's
printings list is how any other one is reached.

## 5. Non-cards, demoted in ranking

Searching `lightning bolt` today returns **`Lightning Bolt // Lightning Bolt` (`astx 76s`,
`layout = 'art_series'`) above the real Lightning Bolt** — the art card's name field contains the
phrase twice, and bm25 rewards that. Collapse does not fix it: art series carry their own
`oracle_id` (measured — 3,610 groups are represented by an art or token row, and **0 of them also
contain a real printing**), so they survive grouping as separate rows.

One term at the front of the **relevance fallback only**:

```sql
CASE WHEN c.layout IN ('art_series','front_card','token','double_faced_token','emblem')
     THEN 1 ELSE 0 END ASC
```

Collapsed, it is the same expression under `min()`, which is safe precisely because no group mixes
the two kinds.

- **Not a filter.** Every printing returned today is still returned, in both modes.
- **Only the fallback.** An explicit sort is what the reader asked for and is left alone. Name order
  is left alone too — an art card whose name differs sorts under its own name, and one whose name
  matches sorts beside the card it depicts, which is where it belongs.
- Measured cost: **0.2 ms either way**, collapsed and uncollapsed. Top five for `lightning bolt`
  goes from two art cards then three real ones, to five real ones.

## 6. The card component, and foil on the art

### 6.1 Extraction

`CardGrid`'s `Tile` privately owns the 5:7 frame, the `mtgimg://` URL, `useImageRetry`, the
`CardImage` identity keying and the no-art fallback. Four other surfaces draw a card and each
rebuilt some of that: the pane's main art, the pane's printings rows, the deck zone rows and
`PrintingPreview`.

New `src/components/CardArt.tsx` owns all of it, plus a `finish` prop and named corner slots.
Consumers pass what they know; nothing guesses. This is what makes the foil treatment one
definition rather than five, and it is the explicit requirement from the design conversation:
*"make sure it's an option on the card component; if we don't have a card component, extract one."*

`CardImage` stays exactly as it is underneath — its URL keying is the fix for art lagging its
caption and is not being re-litigated.

### 6.2 What "foil" means, per surface

The mark states **what the object is**, never what it could have been:

| surface | foil when |
|---|---|
| search results, card pane printings, deck zone rows | the printing exists **only** in foil (12,366 paper printings) or **only** etched (892) |
| collection table row | the entry's own stored `finish` |
| collection wall tile | any copy behind the tile is foil or etched |

Marking the 53,224 printings that merely *have* a foil version would put a sheen on 61 % of every
wall, which is decoration rather than information.

### 6.3 The treatment

A diagonal `linear-gradient(115deg, …)` in the holo hues at **10–14 % opacity** with
`mix-blend-mode: overlay`, so it tints the art and never covers it — the hard requirement from the
brief is that the card stays fully legible. `aria-hidden`, because it is not information a screen
reader needs twice.

Beside it, a small corner chip carrying the finish glyph and an accessible name. The chip is the
part that *says* foil; the sheen is the part that *looks* foil, and neither is asked to do the
other's job.

An optional sheen sweep on hover, `motion-reduce:` off. Per CLAUDE.md, a reduced-motion check
probes `transitionProperty` and never `transitionDuration`.

**A screenshot is the acceptance test here, not an assertion.** The suite can prove the overlay
mounts, carries `aria-hidden` and disappears for a nonfoil card; whether 12 % over a dark Phyrexian
artwork is still legible is a question only the running window answers, so §8's live pass covers it.

## 7. The finish glyph

`FINISH_MARK`'s `{ nonfoil: "", foil: "F", etched: "E" }` becomes a `FinishMark` component: a
sparkle glyph for foil, a distinct glyph for etched, nonfoil still drawing nothing because it is the
finish a price is assumed to be. The full word stays in the accessible name and in the tooltip,
which is what the `<abbr>` was already providing.

**The glyph takes a solid accent tint, not a gradient.** At the 10 px these render at, a gradient is
not perceivable — it costs a `<defs>`/id-collision problem and buys nothing. The gradient stays
where it has area to work in, which is the card art.

Every surface that spells a finish moves to it: the pane's per-finish prices, the pane's printings
rows, the collection table, the wishlist's preferred finish and the quick-add popup.

## 8. Verification

**Rust.** Grouping by `oracle_id`; the representative is the newest printing and the `substr` pick
agrees with an explicit `ORDER BY … LIMIT 1`; `printings` and the price range describe the *matched*
printings under a filter; `ownedQuantity` sums across the card's printings; the capped count counts
cards; each sort's order; the `MATERIALIZED` CTE keeps the 10× name weighting (a test that fails if
someone "simplifies" it to `rank`); the demotion puts the real card first; `idx_cards_collapse` is
in `CARDS_INDEXES` and the v7 step is idempotent; the JSON mirror test picks up the three new
fields.

**TypeScript.** The toggle is in the query key and out of `activeFilterCount`/`resetAll`; the price
range renders both ways; `CardArt` mounts the overlay only for a foil or etched card and marks it
`aria-hidden`; `FinishMark`'s accessible name.

**Storybook.** `CardArt` in nonfoil, foil and etched; a collapsed row and an expanded one.

**The live window, over CDP.** Sheen legibility on real art at both tile sizes, the collapsed browse
opening at its measured speed, and the toggle round-tripping — per CLAUDE.md, a green suite proves
nothing about `mtgimg://` or about a photograph under a gradient.

## 9. Risks

- **The 600–620 ms sorts.** Set, rarity and type on a completely unfiltered collapsed browse —
  roughly double today's 313–325 ms. Known, measured, documented; any text filter takes them to
  ~40 ms. Closing it means resolving the representative's sort keys from a covering index before the
  limit, which the wide-index measurement says is not free.
- **`MATERIALIZED` is invisible load-bearing syntax.** Dropping it is a runtime SQL error rather
  than a bad ranking, so it fails loudly — but only on a *text* search, which is why a test covers
  that path specifically.
- **The art-card invariant.** "No oracle group mixes art/token rows with real printings" is true of
  today's corpus (0 of 3,610) and is what makes the `min()` demotion exact. If Scryfall ever
  violates it the demotion degrades to "the group is demoted if any of its printings is a non-card",
  which is a ranking nudge and not a correctness failure.
