# The Tags page — design

**Written 2026-08-20.** Every measured figure in this document comes from
[the Art Tags research](../research/2026-08-20-scryfall-art-tags.md) and
[the Oracle Tags research](../research/2026-08-14-scryfall-oracle-tags.md), both live-verified
on Windows. Read the art one before implementing: it carries the traps this design is shaped
around.

## What this is for

**Building a deck around an art theme or a motif.** A reader wants every card whose
illustration has a dog in it, narrowed to their commander's colours and to a format they can
play, with the cards going into a deck from the same surface they were found on.

Oracle tags — what a card *does* — ride along on the same page because they come from the same
project, share the same shape and answer the neighbouring question. They are **secondary**.
Every ranking, default and layout decision below breaks toward art.

This is an *alternative* tag search, not a port of `tagger.scryfall.com`. Two deliberate
departures, both stated where they arise: **the search box does substring matching**, which
Scryfall's `otag:` does not, and **tags accumulate into a set** rather than being asked one at
a time.

## What already exists

`src-tauri/src/oracle_tags.rs` (2,479 lines) downloads the `oracle_tags` bulk file weekly,
flattens its hierarchy, and stores four tables plus a watermark. It works, it is well tested,
and the deck auto-categoriser depends on it. **The whole oracle half of this feature is a
query surface over data the app already has.** Nothing in `search.rs` or `filters.rs` mentions
tags today; the only consumer is `autoCategory.ts`.

There is no art-tag anything.

## Architecture

### 1. Data — schema v20

Art taggings key on **`illustration_id`**, oracle taggings on **`oracle_id`**. That is not a
formatting quirk to normalise away: an art tag is a fact about an *illustration*, so it belongs
to the printings carrying that art and to no others. A card with five arts has five
illustrations and the dog is in one of them.

So art gets its own tables rather than a `kind` column on the oracle ones:

```sql
art_tags(slug PRIMARY KEY, id TEXT NOT NULL, label TEXT NOT NULL, description TEXT) WITHOUT ROWID;
art_tag_parents(child_slug, parent_slug, PRIMARY KEY (child_slug, parent_slug)) WITHOUT ROWID;
art_taggings(illustration_id, slug, weight TEXT, annotation TEXT,
             PRIMARY KEY (illustration_id, slug)) WITHOUT ROWID;
art_tag_illustrations(illustration_id, slug,
                      -- The STRONGEST weight among the direct taggings this row descends
                      -- from. See §4: a closure row can be reached from several taggings
                      -- with different weights, so "is this a weak match" has no answer
                      -- unless it is resolved once, here, at ingest.
                      weight TEXT NOT NULL,
                      PRIMARY KEY (illustration_id, slug)) WITHOUT ROWID;
art_tag_meta(id INTEGER PRIMARY KEY CHECK (id = 1), etag, updated_at,
             ingested_at, checked_at, tag_count, tagging_count);
```

`art_tag_illustrations` is the closure — every tag a printing's illustration holds **and every
ancestor of those tags** — and it is the only table read at query time. **951,499 rows**, a
2.0× expansion of the 475,163 direct taggings.

Three reasons this is a second set of tables and not a widened first set:

- The join column genuinely differs. One table would need either a nullable pair of columns or
  a generic `subject_id`, and both give up the ability to declare and index either honestly.
- Merging 951 k art rows into `oracle_tag_cards` makes the deck categoriser's prefix scans
  strictly worse, for nothing it wants.
- The oracle tables ship inside a fenced staging swap
  (`the_oracle_tag_staging_tables_match_the_live_ones`) at schema v19. Rewriting the swap, the
  fence and the closure builder to add a discriminator buys the oracle path nothing.

**`id` is stored beside `slug`.** Scryfall's docs say plainly: *"Do not treat tag slugs or
labels as permanent identifiers […] Use the `id` field."* The slug stays the primary key —
storage is rebuilt wholesale on every ingest, so a rename is harmless there — but anything that
*persists* a tag across ingests must be able to notice a rename. Today that is the categoriser's
anchor list; from this feature on it is also every muted tag and every saved selection.
`oracle_tags` gains the same column in the same migration.

**`idx_cards_illustration ON cards(illustration_id)` is new and mandatory.** The four indexes on
`cards` today are oracle, set_cn, name and collapse. A loop of 50 k point lookups on
`illustration_id` against the 609 MB dev database did not finish in five minutes. The index goes
in **`CARDS_INDEXES`**, because `swap_staging` drops and recreates `cards` on every sync and an
index declared anywhere else silently disappears the next morning.

**`annotation` is stored and nothing branches on it** — the oracle rule, for the oracle reason:
it is data we were given, and inventing it back later needs a re-download. It is *omitted*
rather than null on the 99% of taggings that lack one, which is a different absence from
`description`'s null and needs a different parse.

**`weight` is the exception, and it is the one thing art tags can do that oracle tags cannot.**
It is carried onto the closure as the *strongest* weight among the direct taggings a closure row
descends from — `very_strong` > `strong` > `median` > `weak`. Resolving it at ingest is what
makes a weight floor answerable at all: a printing reachable from a `weak` `dog` tagging *and* a
`strong` `hound` one is not a weak match, and a query over per-tagging weights would have to
decide that at read time, per row, on every keystroke. See §4.

### 2. Ingest — a shared engine

`oracle_tags.rs` splits into:

```
src-tauri/src/tags/mod.rs     the engine, parameterised
src-tauri/src/tags/oracle.rs  the oracle binding
src-tauri/src/tags/art.rs     the art binding
src-tauri/src/tags/query.rs   the read surface (§3)
```

The engine owns everything the two datasets do identically: the `If-None-Match` check through
`scryfall::Client::check_bulk_dataset` (already generic over the dataset name), the download,
the gz JSONL parse, the ancestor closure, the staging create/batch/swap, the meta watermark and
staleness, the progress emit, and the "no tags parsed means refuse and swap nothing" guard. A
binding supplies: the bulk dataset name, the subject column, the five table names, the progress
event name and the refresh interval.

**This refactor is the risk centre of the plan.** It moves shipped code the deck categoriser
depends on. It gets its own task, its own commit and its own full `npm run verify` before
anything is built on top of it, and the existing oracle tests move with it unchanged — a test
that had to be edited to keep passing is a behaviour change, not a move.

Rules the engine inherits verbatim from `oracle_tags.rs`, each with its existing reason:

- **Follow every parent edge, never `parent_ids[0]`, never `child_ids`.** 43% of art tags have
  more than one parent and the graph runs to depth 10.
- **Visited set and dangling-id guard on the walk**, though this build has neither cycles nor
  dangling ids.
- **A card tagged only `spot-removal` must answer a `removal` query.** The bulk file stores
  direct taggings only and category tags have none of their own; `removal` has zero. A
  direct-only implementation returns 31% of the dogs and looks like it is working.
- **Nothing here may break a launch or a card sync.** Spawned, best-effort, silent; a failure
  leaves the previous rows standing and writes the reason to `error_log`.
- **Bad input is never fatal** — an unparseable line is counted and stepped over. A file that
  yields *no* tags is refused outright and swaps nothing.

Art refreshes on the same weekly interval as oracle. The files regenerate daily, but a themed
search should not quietly re-rank itself between two sessions on one afternoon, and the ETag
makes a check that finds nothing cost zero bytes. Both run at launch when stale, independently
of each other and of the card sync.

**Both download eagerly** — art is not gated behind the reader opening the page. It is 12.5 MB
from `data.scryfall.io`, which is unmetered; both tag files together measured 0.67 s.

### 3. Query — tag terms are card filters

Two new commands for the tags themselves, in `tags/query.rs`:

- **`tag_search(text, namespace, limit)`** → ranked `TagHit`s. Matches label, slug, aliases and
  description across both namespaces.
- **`tag_children(namespace, slug)`** → one node's children with counts, for the rail.

```rust
pub struct TagHit {
    pub slug: String,
    pub id: String,
    pub label: String,
    pub namespace: TagNamespace,   // "art" | "oracle"
    pub description: Option<String>,
    pub card_count: i64,           // distinct subjects via the closure
    pub parents: Vec<TagRef>,
    pub child_count: i64,
}
```

**Matching.** Normalise `[^a-z0-9]` → `""` on both sides, which reproduces Scryfall's own
behaviour exactly and folds `spot removal`, `spot-removal` and `SpotRemoval` into one tag. Then
rank: exact normalised match, then prefix, then substring; within a band by `card_count`
descending; **art above oracle at equal rank**, because that is what the page is for.

Substring matching is the departure. Scryfall's `otag:remov` returns 404 and its `*` is
stripped rather than expanded — verified — so type-ahead over these tags has to be built rather
than borrowed. A free-text box that only matched exact slugs would not feel like a search box.

**Cards come from `search_cards`, unchanged in shape.** `CardFilters` and `SearchRequest` gain:

```ts
artTags?:    { include?: string[]; exclude?: string[] };
oracleTags?: { include?: string[]; exclude?: string[] };
artWeightFloor?: "any" | "strong";   // §4
```

compiled by `push_card_filters` into `EXISTS` / `NOT EXISTS` against the two closures:

```sql
EXISTS (SELECT 1 FROM art_tag_illustrations a
         WHERE a.illustration_id = {alias}.illustration_id AND a.slug = ?)
EXISTS (SELECT 1 FROM oracle_tag_cards o
         WHERE o.oracle_id = {alias}.oracle_id AND o.slug = ?)
```

**This one decision is what makes the page cheap.** The Tags view reuses `search_cards`,
`useCardSearch`, `FilterBar`, the sort headers, the infinite pager and the marketplace price
column wholesale, instead of growing a second search stack that would drift from the first.
Includes AND with each other and with every existing filter; excludes are `NOT EXISTS`.

The fields sit on `CardFilters`, which is flattened into the collection and wishlist queries
too. Absent means no filter, so neither changes. **Neither the Search page nor those two views
send them** — tag search stays on the Tags page, as scoped.

**Faceting.** `FilterBar` greys unreachable options from an in-memory `CardIndex` bitset that
knows nothing about tags, so a tag-narrowed search would show inflated counts. The greying
itself still fails open — not-greyed means "we don't know", which is the safe direction — but
the numbers beside the options would be wrong. Fix: build a bitset from the closure for the
current chip set and AND it into the facet base. Chips change on a click rather than a
keystroke, so it caches on the chip set and costs one indexed query per change. **If this
proves to be more than one task's work, the fallback is to fail open and say so in
`search-faceting.md` — wrong counts are worse than absent ones, so the third option, doing
neither, is not available.**

### 4. Weight — the one thing art tags can do that oracle tags cannot

Oracle taggings are 99.7% `median` and `strong` appears exactly once in the whole file; the
2026-08-14 conclusion that "the app cannot rank a card's tags by confidence" is a statement
about *oracle* tags and does not carry over. Art tags use the full scale: 462,008 `median`,
5,980 `strong`, 4,495 `weak`, 2,680 `very_strong`, where Scryfall defines `weak` as "a minor
detail or background element" and `very_strong` as "exemplary".

- **Every weight shows by default.** Hiding cards from a discovery surface is the worse failure,
  and silent narrowing is the hardest kind to debug later.
- **A "Strong matches only" toggle** drops `weak` — for a reader who wants the castle to be the
  subject rather than scenery. It is `artWeightFloor` above, and it reads
  `art_tag_illustrations.weight`, which §1 resolved to the strongest weight per closure row. It
  applies to art only; on oracle tags it would filter nothing, which is why it is not offered
  there.
- **The floor is over the closure, not the direct tagging, and the two differ.** A printing
  whose `dog` tagging is `weak` but whose `hound` tagging is `strong` survives the floor under
  both slugs, because it is genuinely a strong match for the motif. Filtering per direct tagging
  would drop it from `dog` while keeping it under `hound` — the same card, in and out of two
  views of one hierarchy.
- **`very_strong` is marked on the tile**, as Tagger's own gold star does.

### 5. UI

`ViewId` gains `"tags"`; `NAV` gains `{ id: "tags", label: "Tags", Icon: Tags }` after Search.
`ZoomSection` gains `"tags"` so the page keeps its own ctrl+wheel zoom.

```
src/features/tags/
  TagsPage.tsx        search box + namespace toggle, tag rail, results
  TagSearchBox.tsx    the free-text box
  TagTree.tsx         the DAG rail — a tag renders under each of its parents
  TagChips.tsx        include/exclude chips with a NOT toggle
  TagResults.tsx      CardGrid / VirtualTable + FilterBar, wired as SearchPage wires them
  useTagSearch.ts     the tag-name query
  tagFilters.ts       the chip set: reducer, normalisation, query-key derivation
```

Layout is the approved one: search box and namespace toggle across the top, tag rail on the
left under it, cards filling the rest, chips above the wall.

**The namespace toggle defaults to Both.** It was the one option with a real hazard — a reader
on the wrong setting sees an empty result and blames their spelling — and defaulting to Both
means the toggle can only ever *narrow* something already visible.

**Collapse defaults off, and this is load-bearing.** `collapse` folds every printing of a card
into one row, represented by the newest. For an art theme that is precisely wrong: the tagged
thing is *this illustration*, and collapsing would show a reader a printing whose art has
nothing to do with what they searched for. Art results are printings.

**Tag muting** — right-click a tag → "Hide this tag", stored in a small user table keyed on
`(namespace, tag_id)`, with an unhide list in Settings. Scryfall asks for this in as many words:
*"Downstream applications are strongly recommended to implement a way to temporarily disable
display of individual tags"*, because Tagger is crowdsourced and they cannot guarantee it is
free from abuse. Keyed on `id` rather than slug, per §1. Muting hides the tag from search
results and the rail; it is not a card filter.

### 6. Every general page feature

The page is not a list — it is a card surface, and it carries what every other card surface in
this app carries. Each of these is already generic; the work is wiring the props `SearchPage`
wires. **This list is the acceptance checklist:**

- Right-click card menu (`buildCardMenu` + `useContextMenu` + `useCardMenuDeps`), **and**
  Shift+F10 / the ContextMenu key — a menu only a mouse can open is a menu half the readers do
  not have
- Card detail pane · All-printings dialog · card walk, so the modal's chevrons and arrow keys
  step along these results
- Drag a tile to the sidebar's Decks and Wishlist entries
- ctrl+wheel zoom, in this section's own corner
- Grid ⇄ table toggle, arrow-key grid nav, sortable headers
- Quick-add to collection; owned/wishlist badges, finish marks, game-changer crown
- Image prefetch for the page that just landed
- The full FilterBar, infinite paging, marketplace price column

## Error handling

The floor, everywhere, is the same shape the rest of this app uses: **a missing taxonomy is a
sentence, never an error.**

- **Art tags never ingested** — the page says so and offers the oracle half plus a refresh
  button. It does not look broken and it does not block.
- **A refresh fails** — the rows already on disk stay exactly where they are; the reason goes to
  `error_log`. This is the price-feed and oracle-tag rule, unchanged.
- **A tag the closure has no rows for** — an empty result with the tag named, not a blank wall.
- **A printing with a NULL `illustration_id`** (4,977 of 116,712) simply matches no art tag.
  `NULL = NULL` is not true in SQL, so this needs no branch — but it does need a test, because
  it is the silent half of the join.
- **Facets** fail open, as they already do: not-greyed means "we don't know".

## Testing

**Rust** — ingest of both datasets from committed fixtures; the closure over a multi-parent
fixture, a cyclic one and one with a dangling parent id; **the closure's weight resolution,
where one row descends from taggings of two different weights and must come out as the
stronger**; the `EXISTS`/`NOT EXISTS` predicates including the NULL-`illustration_id` case and
the weight floor; the staging-swap fence extended to the art tables;
the v19→v20 migration, both from v19 and from a fresh database; `idx_cards_illustration`
surviving a `swap_staging`.

**TypeScript** — tag normalisation and ranking; the chip reducer including include/exclude and
de-duplication; `TagsPage` and `TagResults` suites; the fake DB extended with art tags, its
`artTagsMissing` and `artTagsFetchError` faults mirroring the oracle ones; stories for the page,
the tree and the chips.

**Live** — a CDP pass against the real window is required, not optional. Every UI task in Plans
2–3 found something the suite could not. The §6 checklist is what that pass walks, and the
right-click menu is the first item on it.

## Out of scope

- **Tagger's relationship taxonomy** (`SIMILAR_TO`, `DEPICTS`, `BETTER_THAN`, …). It hangs off
  cards rather than tags, is not in bulk data at all, and would mean scraping.
- **`PRINTING_TAG`**, Tagger's third namespace. No bulk export, no search keyword; `ptag:` and
  friends return HTTP 400.
- **Writing tags back to Tagger.** Submitting needs a Scryfall supporter account.
- **Tag search on the existing Search page.** Scoped out deliberately; the backend fields exist
  and are unsent, so it stays a UI decision to revisit rather than a migration.
- **`ancestry` as Scryfall's GraphQL returns it.** Not in the bulk file; reconstructed locally
  from `parent_ids`.

## Documentation to update in the same change

Per the repo rule that a prose-only edit routes to neither CI job and so rots silently:

- Root `CLAUDE.md` — the Oracle Tags paragraph gains art tags, and its "Weekly" is corrected to
  say the *file* is daily and the *app's interval* is weekly.
- `src-tauri/CLAUDE.md` — the new module layout and the v20 rung.
- `docs/reference/data-and-sync.md` — the schema ladder and the new tables.
- `docs/reference/scryfall.md` — the `art_tags` bulk entry and the browser-UA 403 note.
- `docs/reference/search-faceting.md` — how tag terms reach the facet base.
