# Search filter faceting, and the in-memory card index behind it

**Status:** design, approved 2026-08-11. Implementation splits into two plans (below).
**Measured against** a page-for-page online backup of the live database, 2026-08-11:
116,694 printings, 107,337 paper, 986 paper set codes, 37,553 paper oracle groups, 917 MB,
schema v7. Medians of five after a warm-up.

## 1. What this is

Filter options on the card search page **grey out when choosing them would not change the
result set**. A set with no matching printings, a mana value nothing costs, a format nothing
is legal in: still drawn, still readable, not pressable. So narrowing a search becomes a
matter of pressing what is left rather than guessing and backing out.

That is the feature. The reason it needs a design document is that faceting is a counting
problem — one count per option per dimension, on every filter press — and the honest way to
pay for it turns out to be the same structure that fixes the search page's own worst cases.

**The budget is 100 ms for any interaction, in every scenario.** Not an average.

## 2. The rule

> **An option greys out when turning it on would not change the result set.**

One sentence for every control, and it has to be that sentence rather than "would return
nothing", because the filters do not all narrow:

- **Sets, mana values, formats** narrow. Turning one on with nothing to match returns
  nothing, so "no change" and "no results" agree.
- **Colours broaden.** `colors` is subset semantics: with `U` on, pressing `W` asks for
  "castable in WU", which is a *superset*. So a colour chip greys when adding it brings in
  no new cards — with nothing selected that means "no card here fits in mono-white", and
  with `R` selected it means "no white or R/W card to add". Both readings are true under
  the one rule; "would return nothing" would be false in the second and would grey a chip
  that does something.

Three consequences, all binding:

- **A selected option is never greyed.** The way out of a dead end stays open. If a search
  matches nothing at all, every unselected option greys and `Reset all` is the escape.
- **Not-greyed means "we don't know", never "this is empty".** Every failure — index still
  warming, command errored — fails *open*. A control that wrongly stays live costs one
  press; one that wrongly greys hides cards that exist.
- **Counts ride in the tooltip and the accessible name**, not on the chips. The mana chips
  are 36px squares and the colour chips are round symbols; a numeral turns either into a
  different control. `title="Modern, 12,481 printings"`, and the same string joins the
  accessible name.

**Counts are printings, and say so.** The search view collapses printings into cards, so a
facet count and the list's own total count different things. Greying is unaffected — zero
printings is zero cards — and counting distinct groups per facet value would cost a
seen-set per option. The word "printings" in the tooltip is the whole fix.

### 2.1 Per-control behaviour

| Control | Greyed when | Mechanism |
|---|---|---|
| Colour chips | adding it brings in no new cards | `aria-disabled`, stays focusable |
| Mana value chips | no matching printing has that value | `aria-disabled`, stays focusable |
| Set picker rows | no matching printing is in that set | `aria-disabled`, as the `MAX_SETS` cap already does |
| Format select | nothing matching is legal or restricted there | native `<option disabled>` |
| Owned chip | **never** | one button, three states — see below |

`aria-disabled` and not `disabled`: a disabled button leaves the tab order, so a keyboard
reader would watch the filter row shrink and grow as they type. The chip stays focusable
and ignores the press.

The **Owned** chip is never disabled. It is one button cycling off → owned → missing → off,
and grey­ing it would strand whoever is mid-cycle. It carries both counts in its tooltip.

The set picker keeps hiding sets with **no printings at all** — a fact about the corpus, not
about this search — and greys sets with none *in this search*. Hiding the latter would make
the list jump under the cursor while the reader types.

## 3. Why an in-memory index

Faceting was specced three ways and measured three ways. The numbers decided it.

### 3.1 What was rejected, and why

**Facet queries against `cards` as it stands.** A four-dimension pass on an unfiltered
browse: **2,238 ms**. `cards` rows average ~2 KB because `raw` is a gzip blob, so counting
986 set codes walks ~230 MB of pages, and the format facet parses JSON 107,337 times.

**A covering index plus a `legal_mask` column.** The same pass: **62 ms**. This is the
SQLite spelling of Lucene's doc values (a narrow column-stride structure) and global
ordinals (values interned to integers). It is a 36× improvement and it is not enough: a
one-character search box entry matches 100,129 rows, and seeking those rowids into `cards`
costs ~350 ms whichever direction the join runs.

**A `card_facets` shadow table**, 7 MB, rowid-aligned, so the seek lands in 7 MB instead of
917 MB. Best pure-SQL result:

| | `cards` | shadow table |
|---|---:|---:|
| `"dragon"*` (2,732 hits) | 3.4 ms | 3.3 ms |
| `"dr"*` (20,596 hits) | 104 ms | 21.6 ms |
| `"a"*` (100,129 hits) | 462 ms | 118 ms |

Folding every dimension into one grouped scan and summing in Rust took the unfiltered case
to 59 ms, but `"a"*` stayed at **106 ms** and `"a"*` with four distinct bases at **167 ms**.
**Pure SQL cannot hold 100 ms.** The floor is the row seeks, and no index removes them.

### 3.2 What won

An in-memory index, built once per corpus, in the shape Lucene actually uses:

- **Bitsets** for low-cardinality dimensions — 6 colours, 10 mana buckets, 23 formats,
  paper, owned. Counting is `AND` + `popcount` over 3,647 machine words.
- **An ordinal array** for the high-cardinality one. `setOrd[doc]` is a `u16`; counting is
  `for doc in base { counts[setOrd[doc]] += 1 }`.

The ordinal array is the whole difference, and getting it wrong is what made the first
estimate useless:

| | bitset per set (986 of them) | ordinal array |
|---|---:|---:|
| resident | 14.3 MB | **0.78 MB** |
| sets facet | 11 ms | **0.12 ms** |

Measured facet cost, every scenario (JS harness, so a conservative bound on Rust):

| Scenario | SQL, best shape | In memory |
|---|---:|---:|
| unfiltered browse | 59 ms | **0.31 ms** |
| `"dragon"*` | 3.9 ms | 1.3 ms |
| `"dr"*` | 21 ms | 8.7 ms |
| `"a"*` (100,129 hits) | 106 ms | **56 ms** |
| `owned=false` | 88 ms | ~1 ms |
| `"a"*` + all four filters | 167 ms | **57 ms** |

Worst case **57 ms**, and 25 ms of that is the FTS scan itself, which no design avoids.

## 4. The search page's own numbers

Measuring faceting turned up two things about the search that were not known.

**CLAUDE.md's 277 ms browse figure is stale.** `idx_cards_collapse`, added for the collapsed
search, gives the sort a 13.45 MB index to scan instead of 900 MB of rows. The uncollapsed
browse is 10.5 ms today; the collapsed browse the view actually uses is **54 ms**.

**Every filter the search offers is missing from that index**, so *using* one costs 8–10×.
`legal_mask` — needed for faceting regardless — is what lets the format filter into an index
at all. Widening `idx_cards_collapse` with `legal_mask, cmc, color_identity`:

| Collapsed search scenario | today | widened |
|---|---:|---:|
| unfiltered browse | 53.8 ms | 57.8 ms |
| browse + format | 505 ms | **40.6 ms** |
| browse + colours | 468 ms | **40.5 ms** |
| browse + mana values | 455 ms | **36.3 ms** |
| browse + all three | 459 ms | **22.7 ms** |
| sort by price + format | 505 ms | **46.2 ms** |
| browse + sets | 2.8 ms | 3.0 ms |

**+0.89 MB** (13.45 → 14.34 MB) and 581 ms to build, against the ~0.7 s the shipped index
already costs each sync. The 4 ms it adds to the unfiltered browse is the price, paid
knowingly. (`schema.rs` records that widening this index with `rarity`/`set_code`/`type_line`
was measured and was a loss. Those are TEXT and are not filter columns; these three are small
and are every filter the view has. The earlier measurement stands — it was answering a
different question.)

**One scenario survives every index.** Sorting a collapsed list by **Set, Rarity or Type**
costs 290–316 ms, because those columns belong to the *representative printing* rather than
to the group: the group step must build all 37,553 groups and join before it can order.
Tried and rejected: a leading-equality index on the rarity expression (329 ms vs 290 ms), and
an index on `(is_paper, name, oracle_id, …)` for the group step (76 ms vs 54 ms — a loss).

In memory this is not a special case at all. The representative is a per-group max over a
recency rank; ordering reads the representative's rank array. One pass over the base, a
heap of 50.

> **Amended 2026-08-14 — the representative is no longer a recency rank alone.** The SQL rule
> changed that day to the **cheapest printing of the card's latest release date, at the reader's
> marketplace**: `released_at` DESC, then price ASC (an unpriced printing losing to every priced
> one), then `id` DESC. §5.2's `recencyRank` is therefore not enough on its own — a Plan B index
> would need the price in the same composite rank, and the rank would be
> **marketplace-dependent**, which is the substantive new constraint: one array per marketplace,
> or a rank recomputed when the setting changes. Plan B has not been built; only Plan A (faceting)
> shipped, and `src-tauri/src/index.rs` holds no ordering arrays. The current rule, with its
> measurements, is in [data-and-sync.md](../../reference/data-and-sync.md).

## 5. Architecture

### 5.1 Schema v8

Two changes, both on `cards`:

- **`legal_mask INTEGER`.** Bit *k* set when legality key *k* is `legal` or `restricted`.
  Backfilled in the migration from the `legalities` column — plain JSON text, not `raw`, so
  `schema::json_raw` has no part to play — measured at ~5 s once. `card_row` computes it
  natively from the next sync on.
  **`LEGALITY_KEYS` is a frozen constant.** Bit positions are stored data: keys may only be
  appended, never reordered or removed, exactly as `CARDS_COLUMNS` is frozen. Scryfall's
  list grows; a key the constant does not know sets no bit, and the format picker offers
  seven of the 23 anyway.
- **`idx_cards_collapse` gains `legal_mask, cmc, color_identity`.** It lives in
  `CARDS_INDEXES` and so replays on every swap. The v8 step re-runs the whole batch, as v7's
  does, after dropping the old definition — every statement is `IF NOT EXISTS`, so a bare
  re-run would leave the narrow index in place.

No new table. No `card_facets`. The shadow table was measured, won its round against
`cards`, and lost to memory.

### 5.2 `CardIndex` (new, `src-tauri/src/index.rs`)

One struct, rebuilt wholesale, never patched incrementally. Per-doc arrays are indexed by
`cards.rowid`.

**Dimension data** (facets):
`setOrd: Vec<u16>` · `colors: [BitSet; 6]` · `mana: [BitSet; 10]` · `formats: [BitSet; 23]`
· `paper: BitSet` · `owned: BitSet`

**Ordering data** (search):
`oracleOrd: Vec<u32>` (the collapse key, `coalesce(oracle_id, id)`) ·
`recencyRank: Vec<u32>` (which printing represents a group: `released_at` then `id` — **the rule
gained a price key on 2026-08-14; see the amendment in §4**) ·
`nameRank`, `typeRank`, `setSortRank` (set code, then *natural* collector number) ·
`rarityRank: Vec<u8>` · `price: Vec<f32>`

The dimension data is the **0.78 MB** measured in §3.2 and is all faceting needs. The
ordering arrays are what Plan B adds: six more per-doc arrays, ~2.8 MB, for roughly
**3.5–4 MB resident** at 116,694 printings once both plans have landed.

**Lifecycle.** Built on a background thread from **its own read-only connection** — a
~0.5–1 s read holding `db_read`'s mutex would stall searches at launch, which is the exact
failure `db_read` exists to prevent. Built at startup and after each sync swap. `owned` is
rebuilt separately when the collection changes (10–23 ms, measured at 200/2,000/12,000
owned printings). While it is cold, **facets fail open and the search falls back to SQL**.

The warm-up read is the one number in this document that is estimated rather than measured:
467 ms for five columns off a plain scan, and the real read wants about fifteen. **Task 1
measures it.** If it lands badly, the fallback is a covering index for the read, at the
usual price of a slower swap.

### 5.3 `facet_cards`

A second command taking the same `SearchRequest`, on the blocking pool. Separate from
`search_cards` because facets depend on neither `sort` nor `offset` and must never delay
page one.

Each dimension is counted over a base carrying **every filter except its own** — Solr's
`excludeTags` rule, and the thing that keeps the set picker's multi-select usable. Colours
use the toggle-difference semantics of §2. Text becomes a bitset built from FTS rowids.

### 5.4 The search, served from the index

When the index is warm, `search_cards` resolves filters, grouping, ordering, paging and the
total against it, then fetches the ≤50 representative rows from SQL by id for their display
columns. `total` stops being capped at 5,000 — a popcount is exact — so the UI stops
rendering `5,000+`.

**This is a second implementation of the ordering contract, and that is the main risk in
this document.** It is taken deliberately, and fenced:

- The SQL path stays, as the cold-start fallback, so it keeps running rather than rotting.
- **A differential test is the load-bearing test of the whole project**: over a fixture
  corpus, a matrix of (filters × sorts × collapse × page) run through both implementations,
  asserting identical ids in identical order. Every behaviour CLAUDE.md pins — the newest
  printing of a name first, rarity as rank, natural collector numbers, `NULLS LAST` in both
  directions, ties paging without repeats, bm25 relevance — is a row in that matrix.

## 6. Frontend

`useCardFacets`, keyed on the filter half of the search key (no sort, no offset), holding
the previous answer while a new one is in flight so chips do not flicker. `FilterBar` and
`SetCombobox` consume it and apply §2's rule. Nothing else changes shape.

The deck editor's docked search panel shares `FilterBar` and gets this for free.

## 7. Testing

- **Differential SQL ↔ index** over the matrix in §5.4. The one that matters most.
- **Facet semantics**: a dimension's counts exclude its own filter; colour toggle-difference;
  a selected option is never greyed; everything fails open when the index is cold.
- **`legal_mask`**: the mask agrees with `json_extract` for all 23 keys; the migration
  backfills; a frozen-key-order test that fails loudly if someone reorders `LEGALITY_KEYS`.
- **Frontend**: greying rules, `aria-disabled` rather than `disabled`, tooltip counts.
- **Storybook**: a seed with a narrow corpus so greying is visible in the workbench.
- **A live CDP pass**, per CLAUDE.md — every UI task so far has found something the suite
  could not.

## 8. Out of scope

- The collection and wishlist filter rows. Same components, a separate decision.
- Rarity as a search filter. The backend supports it; the view does not offer it.
- **Moving `raw` out of `cards`.** It is 235 MB of the 917 MB database and nothing reads it
  at runtime; a side table would make every scan in the app cheaper. Noticed while measuring,
  genuinely promising, and nothing to do with faceting.

## 9. Implementation, in two plans

Split because the second depends on the first being built and proven, and because the first
is shippable alone.

**Plan A — the index and faceting.** Schema v8, `CardIndex` and its lifecycle, `facet_cards`,
the frontend greying, the widened index (which is worth shipping on its own: it is the 505 ms
→ 41 ms row above). Ends with faceting working and the search untouched.

**Plan B — the search on the index.** Ordering, grouping, paging and the exact total moved
onto `CardIndex`, with the differential test and the SQL fallback. Ends with every scenario
in this document under 100 ms.
